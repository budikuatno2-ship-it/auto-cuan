'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(ROOT_DIR, 'bukti-verifikasi-final', 'fase17');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function checkServer(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve(res.statusCode < 500);
    }).on('error', () => {
      resolve(false);
    });
  });
}

async function run() {
  console.log('[Fase17] Checking server...');
  const isUp = await checkServer(`${BASE_URL}/`);
  if (!isUp) { console.error('[Fase17] No server!'); process.exit(1); }
  console.log('[Fase17] Server OK.');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  function saveJSON(name, data) {
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2), 'utf8');
    console.log('  [JSON] ' + name);
  }

  async function saveScreenshot(page, filename) {
    const dest = path.join(OUT_DIR, filename);
    await page.screenshot({ path: dest, fullPage: false });
    console.log('  [SCREENSHOT] ' + filename);
  }

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "x-autocuan-preview": "1" });

    var all = {};
    console.log("[Fase17] Starting 16 captures...");

    async function login(){await page.evaluate(function(){try{localStorage.setItem("autocuan_user","budi");localStorage.setItem("autocuan_role","admin");localStorage.setItem("autocuan_is_admin","true");localStorage.setItem("autocuan_logged_in","true");localStorage.setItem("auto_cuan_onboarding_seen","true")}catch(_){}var ob=document.getElementById("onboardingModal");if(ob)ob.classList.add("hidden")})}
    async function setTheme(th){await page.evaluate(function(theme){if(theme==="dark"){document.documentElement.classList.add("dark");document.documentElement.classList.remove("light")}else{document.documentElement.classList.add("light");document.documentElement.classList.remove("dark")};if(typeof window.applyAppTheme==="function")window.applyAppTheme(theme)},th)}
    async function cap(num,target,theme,w,h,m){console.log("["+num+"/16] "+target+" "+theme);await page.setViewport({width:w,height:h,isMobile:m,hasTouch:m});await page.goto(BASE_URL+"/",{waitUntil:"networkidle2"});await login();await setTheme(theme);await page.evaluate(function(t){if(typeof window.navigateTo==="function")window.navigateTo(t)},target);await new Promise(function(r){setTimeout(r,2000)});await saveScreenshot(page,"fase17_"+target+"_"+w+"_"+theme+".png")}

    await cap(1,"watchlist","light",1440,1060,false);
    await cap(2,"watchlist","dark",1440,1060,false);
    await cap(3,"watchlist","light",390,844,true);
    await cap(4,"watchlist","dark",390,844,true);
    await cap(5,"portofolio","light",1440,1240,false);
    await cap(6,"portofolio","dark",1440,1240,false);
    await cap(7,"portofolio","light",390,844,true);
    await cap(8,"portofolio","dark",390,844,true);
    await cap(9,"trackrecord","light",1440,1140,false);
    await cap(10,"trackrecord","dark",1440,1140,false);
    await cap(11,"trackrecord","light",390,844,true);
    await cap(12,"trackrecord","dark",390,844,true);
    await cap(13,"account","light",1440,1100,false);
    await cap(14,"account","dark",1440,1100,false);
    await cap(15,"account","light",390,844,true);
    await cap(16,"account","dark",390,844,true);
    console.log("[Fase17] All 16 done.");
    console.log('[Fase17] Starting captures...');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('[Fase17] Fatal error:', err);
  process.exit(1);
});
