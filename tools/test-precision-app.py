"""Full app preview navigation test; local mock server only, never production.

FINAL-BUG-004: Kelola Keuangan / Money Management is permanently decommissioned.
The deprecated /preview/kelola-keuangan alias must land deterministically on the
Dashboard (never a blank workspace, never the removed worksheet). The remaining
coverage (Portfolio, Analysis destinations, theme/motion, mobile drawer) is
unchanged.
"""
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

def luminance(css):
    channels=[int(n)/255 for n in __import__('re').findall(r'\d+',css)[:3]]
    linear=[v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4 for v in channels]
    return sum(v*w for v,w in zip(linear,[.2126,.7152,.0722]))

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000},reduced_motion='reduce')
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',network)
    try:
        # FINAL-BUG-004: the deprecated alias must resolve to Dashboard, and the
        # decommissioned worksheet must not exist anywhere in the SPA.
        page.goto(BASE+'/preview/kelola-keuangan',wait_until='domcontentloaded')
        page.wait_for_selector('#page-dashboard',state='visible',timeout=30000)
        check('Deprecated kelola-keuangan alias lands on Dashboard',page.locator('#page-dashboard').is_visible())
        check('Decommissioned worksheet is absent from the SPA',page.locator('#page-money-management,#mmCashflowSpreadsheetTable,#mmCashflowSpreadsheetBody').count()==0)
        check('No duplicate Finance journal',page.locator('#mmPanelJournal,#mmTabBtnJournal').count()==0)
        check('Sidebar fixed in full app',page.locator('#appSidebar').evaluate("e=>getComputedStyle(e).position==='fixed'"))
        page.evaluate("navigateTo('portofolio')")
        page.wait_for_selector('#portofolioPartialMount #tabStrip',timeout=30000)
        page.wait_for_function("document.querySelector('#portofolioPartialMount #app') && !document.querySelector('#portofolioPartialMount #app').classList.contains('hidden')",timeout=30000)
        check('Portfolio keeps six primary tabs and scenarios out of the primary strip',
              page.locator('#portofolioPartialMount #tabStrip [data-tab]').count()==6
              and page.locator('#portofolioPartialMount #tabStrip [data-tab="scenarios"]').count()==0
              and page.locator('#portofolioPartialMount .pcc-subnav [data-tab="scenarios"]').count()>=1)
        for tab in ['today','planner','watch','risk']:
            page.locator('#portofolioPartialMount #tabStrip [data-tab="'+tab+'"]').click()
            check('Portfolio '+tab+' opens',page.locator('#portofolioPartialMount #page-'+tab).is_visible())
        page.locator('#portofolioPartialMount .pcc-subnav [data-tab="scenarios"]').first.click()
        check('Portfolio scenarios subview opens',page.locator('#portofolioPartialMount #page-scenarios').is_visible())
        for tab in ['journal','ai']:
            page.locator('#portofolioPartialMount #tabStrip [data-tab="'+tab+'"]').click()
            check('Portfolio '+tab+' opens',page.locator('#portofolioPartialMount #page-'+tab).is_visible())
        for tab in ['analisis-chart','bandarmologi','intel','hunter','insider','ranking','pattern']:
            page.locator('#appSidebar [data-analysis-tab="'+tab+'"]').click()
            page.wait_for_function("tab=>window.__ACTIVE_ANALISIS_SUBTAB__===tab",arg=tab)
            page.wait_for_selector('#analisisPartialMount #analisisInput',state='attached')
            check('Analysis '+tab+' has exactly one active sidebar destination',page.locator('#appSidebar .sidebar-item.active').count()==1 and page.locator('#appSidebar .sidebar-item.active').get_attribute('data-analysis-tab')==tab)
            if tab!='analisis-chart':check('Analysis '+tab+' panel opens',page.locator('#panel-tab-'+tab).is_visible())
        # Rapid navigation ending on the decommissioned destination must resolve
        # deterministically to Dashboard with exactly one visible page.
        page.evaluate("navigateTo('analisis','intel');navigateTo('analisis','hunter');navigateTo('money-management')")
        page.wait_for_timeout(250)
        check('Rapid navigation to a decommissioned page lands on Dashboard',page.locator('#page-dashboard').is_visible() and not page.locator('#page-analisis').is_visible())
        check('Exactly one workspace page is visible after rapid navigation',page.locator('.page-content:not(.hidden)').count()==1)
        page.mouse.move(1100, 100)
        for motion in ['reduce','no-preference']:
            page.emulate_media(reduced_motion=motion)
            for theme in ['dark','light']:
                page.evaluate("theme=>applyAppTheme(theme)",theme)
                page.wait_for_timeout(180)
                check(theme+' '+motion+' workspace width stays inside viewport',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                check(theme+' '+motion+' sidebar profile remains vertical',page.locator('#appSidebar .sidebar-footer').evaluate("e=>getComputedStyle(e).flexDirection==='column'"))
                # FINAL-A11Y-005: sidebar group label must clear AA contrast in both themes.
                colors=page.locator('#appSidebar .sidebar-group-label').first.evaluate("e=>{const fg=getComputedStyle(e).color;while(e){const bg=getComputedStyle(e).backgroundColor;if(bg!=='rgba(0, 0, 0, 0)')return {bg,fg};e=e.parentElement}throw Error('No opaque sidebar background')}")
                bg,fg=luminance(colors['bg']),luminance(colors['fg'])
                check(theme+' '+motion+' sidebar label contrast at least 4.5', (max(bg,fg)+.05)/(min(bg,fg)+.05)>=4.5)
                if theme=='light':check('Light '+motion+' sidebar surface is light',bg>.6)
                if motion=='reduce':page.screenshot(path=str(OUT/('full-app-'+theme+'.png')))
        page.emulate_media(reduced_motion='reduce')
        page.set_viewport_size({'width':1440,'height':520})
        check('Short desktop keeps brand and profile anchored',page.evaluate("()=>{const a=document.querySelector('#appSidebar .sidebar-brand').getBoundingClientRect();const b=document.querySelector('#appSidebar .sidebar-footer').getBoundingClientRect();return a.top>=0&&b.bottom<=innerHeight+1&&b.top>a.bottom}"))
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
