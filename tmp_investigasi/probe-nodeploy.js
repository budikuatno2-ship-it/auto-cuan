'use strict';
// READ-ONLY: simulate deployed/serverless where data/arjum-data is not shipped
// (it is gitignored). ARJUM_DATA_DIR -> empty temp dir before requiring modules.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const emptyDir = path.join(os.tmpdir(), 'ac-empty-arjum-' + Date.now());
fs.mkdirSync(emptyDir, { recursive: true });
process.env.ARJUM_DATA_DIR = emptyDir;
// Force "no ssh key" so VPS SSH path is skipped (deployed has no private key)
process.env.VPS_SSH_KEY = path.join(emptyDir, 'nope.key');

const bandarmologiService = require('../lib/bandarmologi-service');
const intel = require('../lib/bandarmologi-intel-service');

async function main() {
  const ticker = process.argv[2] || 'BBCA';
  console.log('ARJUM_DATA_DIR =', process.env.ARJUM_DATA_DIR);
  console.log('listDiskDates =', JSON.stringify(bandarmologiService.listDiskDates('broker-summary', ticker)));
  console.log('getEffectiveTradingDate() =', bandarmologiService.getEffectiveTradingDate());
  console.log('getDynamicTradingDays(10) =', JSON.stringify(bandarmologiService.getDynamicTradingDays(10)));

  const apiDates = await bandarmologiService.getAvailableDates(ticker);
  console.log('ACTION available-dates -> dates count =', apiDates.length, JSON.stringify(apiDates.slice(0, 12)));

  const p = await bandarmologiService.getBandarmologiData(ticker, { range: '1d' });
  console.log('ACTION bandarmologi 1d -> success=', p.success, 'is_empty=', p.is_empty, 'is_offline=', p.is_offline,
    'demo_reason=', p.demo_reason, 'live=', p.live, 'from_vps_tunnel=', p.from_vps_tunnel,
    'available_dates count=', (p.available_dates || []).length,
    'available_dates=', JSON.stringify((p.available_dates || []).slice(0, 12)));

  const i7 = await intel.getBandarmologiIntel({ range: '7d' });
  console.log('ACTION bandarmologi-intel 7d -> success=', i7.success, 'updated_at=', i7.updated_at, 'counts=', JSON.stringify(i7.summary));
}

main().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
