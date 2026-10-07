"""Real landing/auth/sidebar markup, CSS and handlers in an offline Chromium fixture.
No production requests, no actual login, no claims about real mobile Safari.
"""
import json, os, re
from pathlib import Path
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('PRECISION_TEST_OUTPUT', '/mnt/data/landing-review'))
OUT.mkdir(parents=True, exist_ok=True)
html = (ROOT/'public/index.html').read_text()
soup = BeautifulSoup(html, 'html.parser')
def cssfile(p, seen=None):
    seen = set() if seen is None else seen
    if p in seen or not p.is_file(): return ''
    seen.add(p)
    def imp(m):
        name = m.group(1).split('?')[0]
        return cssfile(ROOT/'public'/name.lstrip('/') if name.startswith('/') else p.parent/name, seen)
    return re.sub(r'@import\s+(?:url\()?\s*[\"\']([^\"\']+)[\"\']\s*\)?\s*;', imp, p.read_text())
styles = []
for element in soup.head.children:
    if getattr(element, 'name', None) == 'link' and 'stylesheet' in element.get('rel', []) and element.get('href', '').startswith('/'):
        styles.append('<style>'+cssfile(ROOT/'public'/element['href'].split('?')[0].lstrip('/'))+'</style>')
    if getattr(element, 'name', None) == 'style': styles.append(str(element))
landing = soup.select_one('#landingPage'); landing['class'] = ['landing-shell']
modals = ''.join(str(soup.select_one('#'+i)) for i in ['authChoiceModal','loginModal','registerModal','selfResetModal'])
# Preserve the real initial hidden sidebar state, rather than revealing it over
# the guest landing page only in this isolated fixture.
aside = soup.select_one('#appSidebar')
for item in aside.select('[data-premium-nav],#tabAnalisisPattern'): item['class']=['sidebar-item']
workspace = '<div id="appShell" class="app-shell hidden">'+str(aside)+'<main id="appMain">'+str(soup.select_one('#appMain > header'))+'</main></div>'+str(soup.select_one('#sidebarScrim'))
fixture = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+''.join(styles)+'</head><body>'+str(landing)+modals+workspace+'</body></html>'
def function(name):
    start = re.search(r'(?m)^(?:async )?function '+re.escape(name)+r'\(', html).start()
    end = re.search(r'(?m)^(?:(?:async )?function |// =====)', html[start+1:])
    return html[start:start+1+end.start()] if end else html[start:]
handlers = '\n'.join(function(n) for n in ['loadLandingShowcase','openAuthChoiceModal','closeAuthChoiceModal','openLoginModal','closeLoginModal','openRegisterModal','closeRegisterModal','openSelfResetModal','closeSelfResetModal'])
theme = html[html.index('function applyAppTheme'):html.index('// ===== COLLAPSIBLE WORKSPACE SIDEBAR')]
sidebar = html[html.index('var SIDEBAR_COLLAPSE_KEY'):html.index('function renderSidebarSessions')]
manager = next(s.get_text() for s in soup.find_all('script') if 'var MODAL_CLOSERS' in s.get_text())
mock = r"""
var _landingShowcaseLoaded=false, _landingShowcaseRequest=null;
window.__mode='error'; window.__calls=0;
window.fetch=async()=>{__calls++;if(__mode==='hang')return new Promise(()=>{});if(__mode==='body-hang')return {ok:true,json:()=>new Promise(()=>{})};
if(__mode==='error')return {ok:false,status:503};if(__mode==='malformed')return {ok:true,json:async()=>({success:false})};
return {ok:true,json:async()=>({success:true,stale:true,snapshot:{sectors:[{name:'Data contoh',avg_change_pct:0.5}],dt_signals:[{ticker:'TEST',signal_type:'RADAR',entry:100,tp:110,sl:95}]}})};};
window.updateLandingCtas=()=>{};window.resetRegisterApprovalView=()=>{};
window.syncRegistrationConsent=()=>{};
window.maintenanceLockActive=()=>false;window.applyMaintenanceGate=()=>{};
window.escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
window.landingPrimaryAction=()=>openAuthChoiceModal();
window.showLandingPage=()=>{};
"""
checks=[];errors=[]
def check(name,value):
    assert value,name
    checks.append(name)
def contrast(page, selector):
    # Chromium serializes color-mix() as color(srgb ...) with 0..1 channels.
    # Let the browser resolve every CSS color into sRGB bytes; extracting numbers
    # and dividing by 255 misreads those normalized channels as nearly black.
    return page.locator(selector).first.evaluate("""e=>{
        const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
        ctx.canvas.width=ctx.canvas.height=1;
        function rgba(color){ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]}
        function over(front,back){const a=front[3]/255;return front.slice(0,3).map((v,i)=>v*a+back[i]*(1-a)).concat(255)}
        const ancestors=[];for(let n=e;n;n=n.parentElement)ancestors.unshift(n);
        let bg=[255,255,255,255];for(const n of ancestors)bg=over(rgba(getComputedStyle(n).backgroundColor),bg);
        const fg=over(rgba(getComputedStyle(e).color),bg);
        function luminance(rgb){const c=rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722}
        const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)
    }""")
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':950})
    page.route('**/*',lambda route:route.abort())
    page.on('pageerror',lambda error:errors.append(str(error)))
    try:
        page.set_content(fixture,wait_until='domcontentloaded')
        page.add_script_tag(content=mock+'\n'+handlers+'\n'+theme+'\n'+sidebar+'\n'+manager)
        page.add_script_tag(content=(ROOT/'public/landing-experience.js').read_text())
        for color in ['light','dark']:
            page.evaluate('(t)=>applyAppTheme(t)',color)
            page.wait_for_timeout(250)
            for width in [320,360,390,768,1024,1440]:
                page.set_viewport_size({'width':width,'height':844});page.wait_for_timeout(50)
                check(f'{color}/{width} page has no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                check(f'{color}/{width} desktop/mobile menu breakpoint',page.locator('#landingMenu').is_visible()==(width>900))
                check(f'{color}/{width} heading contrast',contrast(page,'#landingPage h1')>=4.5)
                check(f'{color}/{width} description contrast',contrast(page,'#landingPage h1 + p')>=4.5)
                check(f'{color}/{width} guest landing has no workspace sidebar',not page.locator('#appSidebar').is_visible())
                check(f'{color}/{width} primary CTA label contrast',contrast(page,'.landing-hero .landing-btn-primary .landing-cta-label')>=4.5)
        page.set_viewport_size({'width':390,'height':844})
        page.locator('#landingMenuToggle').click()
        check('Mobile navigation opens',page.locator('#landingMenu').is_visible())
        page.keyboard.press('Escape')
        check('Mobile Escape closes and restores trigger',not page.locator('#landingMenu').is_visible() and page.evaluate("document.activeElement.id==='landingMenuToggle'"))
        page.locator('#landingMenuToggle').click()
        first_anchor=page.locator('#landingMenu a').first
        expected_target=(first_anchor.get_attribute('href') or '').lstrip('#')
        first_anchor.click()
        check('Anchor closes menu and focuses its declared destination',
              not page.locator('#landingMenu').is_visible()
              and page.evaluate("(id)=>document.activeElement&&document.activeElement.id===id",expected_target))
        page.evaluate('window.scrollTo(0,0)');page.wait_for_timeout(500)
        page.locator('.landing-hero .landing-btn-primary').click();page.wait_for_timeout(25)
        check('Auth choice focuses inside and locks page',page.evaluate("document.getElementById('authChoiceModal').contains(document.activeElement)&&document.getElementById('landingPage').inert&&document.documentElement.classList.contains('auth-dialog-open')"))
        page.locator('#authChoiceModal .landing-auth-card').nth(1).click()
        page.wait_for_function("document.getElementById('registerModal').contains(document.activeElement)",timeout=1000)
        check('Choice to register focuses new form without stale timer',page.evaluate("document.getElementById('registerModal').contains(document.activeElement)"))
        page.locator('#regUsername').fill('local-test')
        for height in [320,450,568,844]:
            page.set_viewport_size({'width':390,'height':height});box=page.locator('#registerModal > div').bounding_box()
            check(f'Registration fits height {height}',box['y']>=0 and box['y']+box['height']<=height+1)
        page.locator('#registerModal button[aria-label]').first.focus();page.keyboard.press('Shift+Tab')
        check('Registration Tab stays in modal',page.evaluate("document.getElementById('registerModal').contains(document.activeElement)"))
        page.evaluate("const m=document.createElement('div');m.id='standaloneTermsModal';m.setAttribute('role','dialog');m.style.cssText='position:fixed;inset:0;z-index:100001;display:flex';m.innerHTML='<div><button id=closeStandaloneTermsBtn>Tutup</button></div>';document.body.appendChild(m);m.querySelector('button').onclick=()=>{m.hidden=true;m.style.display='none'};void 0;")
        page.wait_for_timeout(25);page.keyboard.press('Escape');page.wait_for_timeout(25)
        check('Nested Terms Escape preserves registration and its field',page.locator('#registerModal').is_visible() and page.locator('#regUsername').input_value()=='local-test')
        check('Terms close returns focus within registration',page.evaluate("document.getElementById('registerModal').contains(document.activeElement)"))
        page.keyboard.press('Escape');page.wait_for_timeout(25)
        check('Last modal close restores landing focus and scroll',page.evaluate("!document.getElementById('landingPage').inert&&!document.documentElement.classList.contains('auth-dialog-open')&&document.querySelector('.landing-hero').contains(document.activeElement)"))
        # Exercise dynamically inserted reset modal as authored by auth-v2.
        page.add_script_tag(content=(ROOT/'public/auth-v2.js').read_text())
        page.evaluate('openSelfResetModal()');page.wait_for_timeout(25)
        check('Dynamic reset is managed and keyboard reachable',page.evaluate("document.getElementById('authV2ResetModal').contains(document.activeElement)"))
        page.keyboard.press('Escape');page.wait_for_timeout(25)
        check('Dynamic reset Escape works',not page.locator('#authV2ResetModal').is_visible())
        page.evaluate("window.__calls=0;window.__mode='error';loadLandingShowcase();loadLandingShowcase()")
        page.wait_for_selector('.landing-data-empty')
        check('Snapshot errors are explicit and concurrent requests collapse',page.evaluate('__calls===1') and page.locator('#landingShowcaseChip').inner_text()=='Belum tersedia')
        page.evaluate("window.__mode='malformed';loadLandingShowcase()");page.wait_for_timeout(25)
        check('Malformed snapshot leaves an actionable retry',page.locator('.landing-data-empty button').is_enabled())
        page.evaluate("window.__mode='body-hang';loadLandingShowcase()")
        page.wait_for_function("!document.getElementById('landingShowcaseBody').hasAttribute('aria-busy')",timeout=6500)
        check('Hanging JSON body exits loading state',page.locator('#landingShowcaseChip').inner_text()=='Belum tersedia')
        page.evaluate("window.__mode='success';loadLandingShowcase()");page.wait_for_timeout(25)
        check('Retry displays sourced snapshot and stale label',page.locator('#landingShowcaseBody').inner_text().find('TEST')>=0 and 'terlambat' in page.locator('#landingShowcaseChip').inner_text())
        # Source label cannot be upgraded to Entry by array position.
        check('Source RADAR status is not relabelled Entry',page.locator('#landingShowcaseBody .mock-card').nth(2).inner_text().find('RADAR')>=0)
        page.evaluate("window.__originalFetch=window.fetch;window.fetch=async()=>({ok:true,json:async()=>({success:true,snapshot:{sectors:[{name:'Sektor contoh',avg_change_pct:'0'}],dt_signals:[{ticker:'<img src=x onerror=alert(1)>',signal_type:'RADAR',entry:'9000',tp:null,sl:0}]}})});_landingShowcaseLoaded=false;loadLandingShowcase()")
        page.wait_for_timeout(25)
        check('Numeric source strings preserve explicit zero',page.locator('#landingSectorValue').inner_text()=='0,00%')
        check('Missing levels are explained, not converted to zero',page.locator('#landingTarget').inner_text()=='Belum ada' and page.locator('#landingStop').inner_text()=='0')
        check('Price strings are formatted safely',page.locator('#landingEntry').inner_text()=='9.000')
        check('Source labels cannot inject markup',page.locator('#landingShowcaseBody img').count()==0 and '<img' in page.locator('#landingSignalTicker').inner_text())
        page.evaluate("window.fetch=window.__originalFetch;_landingShowcaseLoaded=false;loadLandingShowcase()")
        page.wait_for_timeout(25)
        page.emulate_media(reduced_motion='reduce');page.evaluate('window.scrollTo(0,document.body.scrollHeight)');page.wait_for_timeout(25)
        check('Reduced motion change cancels every landing animation',page.evaluate("!document.getElementById('landingPage').getAnimations({subtree:true}).some(a=>a.playState==='running')"))
        check('Landing sections remain visible without opacity hiding',page.evaluate("Array.from(document.querySelectorAll('#landingPage .landing-section')).every(e=>getComputedStyle(e).contentVisibility==='visible'&&getComputedStyle(e).opacity==='1')"))
        for color,width in [('light',1440),('dark',1440),('light',390),('dark',390)]:
            page.evaluate('(t)=>applyAppTheme(t)',color);page.set_viewport_size({'width':width,'height':950 if width>900 else 844});page.evaluate('document.activeElement.blur();window.scrollTo(0,0)');page.wait_for_timeout(250)
            check(f'{color}/{width} final CTA contrast after auth runtime loads',
                  contrast(page,'.landing-hero .landing-btn-primary .landing-cta-label')>=4.5
                  and page.locator('.landing-hero .landing-btn-primary .landing-cta-label').evaluate(
                      "e=>getComputedStyle(e).color===getComputedStyle(e.parentElement).color"))
            page.screenshot(path=str(OUT/f'landing-{color}-{width}.png'))
            if width==1440:page.screenshot(path=str(OUT/f'landing-{color}-full.png'),full_page=True)
        # A same-color foreground must fail even when the background uses the
        # CSS Color 4 serialization that caused the false CI failure.
        page.evaluate("()=>{const e=document.createElement('span');e.id='contrastNegative';e.textContent='Low contrast';e.style.cssText='color:rgb(128,128,128);background:color(srgb .5 .5 .5)';document.body.appendChild(e)}")
        check('Contrast negative control rejects normalized sRGB same-color text',contrast(page,'#contrastNegative')<4.5)
        page.evaluate("document.getElementById('contrastNegative').remove()")
        label=page.locator('.landing-hero .landing-btn-primary .landing-cta-label')
        old_style=label.get_attribute('style')
        label.evaluate("e=>e.style.setProperty('color',getComputedStyle(e.parentElement).backgroundColor,'important')")
        check('Contrast negative control rejects actual CTA label matching its surface',contrast(page,'.landing-hero .landing-btn-primary .landing-cta-label')<4.5)
        label.evaluate("(e,s)=>{if(s===null)e.removeAttribute('style');else e.setAttribute('style',s)}",old_style)
        check('Restored CTA label retains 4.5 minimum',contrast(page,'.landing-hero .landing-btn-primary .landing-cta-label')>=4.5)
        page.evaluate("document.getElementById('landingPage').classList.add('hidden');document.getElementById('appSidebar').classList.remove('hidden');document.getElementById('appShell').classList.remove('hidden');document.body.classList.add('sidebar-open');")
        page.locator('#workspaceSidebarToggle').click();page.wait_for_timeout(50)
        check('Real mobile sidebar makes background inert',page.evaluate("document.getElementById('appMain').inert"))
        page.evaluate('openMobileSidebar()');page.keyboard.press('Escape');page.wait_for_timeout(50)
        check('Repeated mobile open preserves original focus and inert state',page.evaluate("!document.getElementById('appMain').inert&&document.activeElement.id==='workspaceSidebarToggle'"))
        check('No uncaught errors',not errors)
    finally:
        (OUT/'landing-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'page_errors':errors,'scope':'Offline real-component Chromium fixture; API and auth environment mocked. Not an authenticated production test.'},indent=2))
        page.screenshot(path=str(OUT/'landing-final-state.png'))
        browser.close()
print(json.dumps({'passed':len(checks),'page_errors':errors}))
