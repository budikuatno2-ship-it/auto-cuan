'use strict';
const bandarmologiService = require('/home/ubuntu/auto-cuan/lib/bandarmologi-service');
const tickers = ['BBCA','BBRI','BMRI','BBNI','TLKM','ASII','BRPT','MEDC','ADRO','CASH'];
const date = '2026-10-16';

async function testAll() {
  const summary = {};
  for (const t of tickers) {
    const resAll = await bandarmologiService.getBandarmologiData(t, { date, flow: 'all' });
    const resF = await bandarmologiService.getBandarmologiData(t, { date, flow: 'F' });
    const resD = await bandarmologiService.getBandarmologiData(t, { date, flow: 'D' });

    summary[t] = {
      all_ok: resAll && resAll.success && !!resAll.broker_summary,
      all_buyers: resAll && resAll.broker_summary ? resAll.broker_summary.top_buyers.length : 0,
      f_ok: resF && resF.success && !!resF.broker_summary,
      f_buyers: resF && resF.broker_summary ? resF.broker_summary.top_buyers.length : 0,
      d_ok: resD && resD.success && !!resD.broker_summary,
      d_buyers: resD && resD.broker_summary ? resD.broker_summary.top_buyers.length : 0,
      has_acc: resAll && !!resAll.broker_accumulation,
      has_insiders: resAll && Array.isArray(resAll.insiders) && resAll.insiders.length > 0
    };
  }
  console.log(JSON.stringify(summary, null, 2));
}

testAll().catch(e => { console.error(e); process.exit(1); });
