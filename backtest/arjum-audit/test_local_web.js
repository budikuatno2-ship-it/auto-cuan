'use strict';
const assert = require('assert');
const bandarmologiService = require('../../lib/bandarmologi-service');
const tickers = ['BBCA','BBRI','BMRI','BBNI','TLKM','ASII','BRPT','MEDC','ADRO','CASH'];

async function testLocalWeb() {
  console.log('Testing local bandarmologi service for 10 stocks...');
  for (const t of tickers) {
    const res = await bandarmologiService.getBandarmologiData(t, { date: 'latest', flow: 'all' });
    assert.ok(res, `Response exists for ${t}`);
    assert.ok(res.success, `Success flag is true for ${t}`);
    assert.ok(res.broker_summary, `broker_summary exists for ${t}`);
    assert.ok(res.broker_accumulation, `broker_accumulation exists for ${t}`);
    assert.ok(Array.isArray(res.insiders), `insiders is array for ${t}`);
  }
  console.log('Local bandarmologi service verification passed for all 10 stocks!');
}

testLocalWeb().catch(e => { console.error(e); process.exit(1); });
