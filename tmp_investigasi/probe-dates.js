'use strict';
// READ-ONLY forensic probe: what does the broker-summary API actually return?
// No writes, no mutations, no network POSTs.
const bandarmologiService = require('../lib/bandarmologi-service');
const intel = require('../lib/bandarmologi-intel-service');

async function main() {
  const ticker = process.argv[2] || 'BBCA';
  const disk = bandarmologiService.listDiskDates('broker-summary', ticker);
  console.log('listDiskDates(' + ticker + ') count =', disk.length);
  console.log('first 5 =', disk.slice(0, 5));
  console.log('last 2 =', disk.slice(-2));

  console.log('getEffectiveTradingDate() =', bandarmologiService.getEffectiveTradingDate());
  console.log('getEffectiveTradingDate(ticker) =', bandarmologiService.getEffectiveTradingDate(ticker));
  console.log('getDynamicTradingDays(10) =', JSON.stringify(bandarmologiService.getDynamicTradingDays(10)));

  const apiDates = await bandarmologiService.getAvailableDates(ticker);
  console.log('getAvailableDates(' + ticker + ') count =', apiDates.length, apiDates.slice(0, 5));

  const payload = await bandarmologiService.getBandarmologiData(ticker, { range: '1d' });
  console.log('getBandarmologiData 1d -> success=', payload.success,
    'from_cache=', payload.from_cache, 'from_disk=', payload.from_disk,
    'is_empty=', payload.is_empty,
    'available_dates count=', (payload.available_dates || []).length,
    'first3=', JSON.stringify((payload.available_dates || []).slice(0, 3)),
    'date=', payload.date,
    'bs.date=', payload.broker_summary && payload.broker_summary.date,
    'date_headers count=', payload.broker_summary && payload.broker_summary.date_headers ? payload.broker_summary.date_headers.length : 0);

  const p7 = await bandarmologiService.getBandarmologiData(ticker, { range: '7d' });
  console.log('getBandarmologiData 7d -> from_cache=', p7.from_cache, 'date=', p7.date,
    'bs.date=', p7.broker_summary && p7.broker_summary.date,
    'date_headers count=', p7.broker_summary && p7.broker_summary.date_headers ? p7.broker_summary.date_headers.length : 0,
    'available_dates count=', (p7.available_dates || []).length,
    'range=', p7.range);

  const p30 = await bandarmologiService.getBandarmologiData(ticker, { range: '30d' });
  console.log('getBandarmologiData 30d -> from_cache=', p30.from_cache, 'date=', p30.date,
    'bs.date=', p30.broker_summary && p30.broker_summary.date,
    'date_headers count=', p30.broker_summary && p30.broker_summary.date_headers ? p30.broker_summary.date_headers.length : 0);

  const i7 = await intel.getBandarmologiIntel({ range: '7d' });
  console.log('intel 7d -> success=', i7.success, 'updated_at=', i7.updated_at, 'total=', i7.total_evaluated, 'counts=', JSON.stringify(i7.summary));
  const i1 = await intel.getBandarmologiIntel({ range: '1d' });
  console.log('intel 1d -> updated_at=', i1.updated_at, 'counts=', JSON.stringify(i1.summary));
  const i14 = await intel.getBandarmologiIntel({ range: '14d' });
  console.log('intel 14d -> updated_at=', i14.updated_at, 'counts=', JSON.stringify(i14.summary));
  const i60 = await intel.getBandarmologiIntel({ range: '60d' });
  console.log('intel 60d -> updated_at=', i60.updated_at, 'counts=', JSON.stringify(i60.summary));

  const idx = i7.indexes || {};
  const s1 = idx.harga_di_bawah_modal_bandar || [];
  console.log('S1 sample:', JSON.stringify(s1.slice(0, 5).map(x => ({ t: x.ticker, price: x.current_price, modal: x.bandar_avg_buy }))));

  const cache7 = intel.getCachedClosePrice ? ['CUAN', 'PTRO', 'PSAB', 'TKIM'].map(t => [t, intel.getCachedClosePrice(t)]) : [];
  console.log('getCachedClosePrice:', JSON.stringify(cache7));
}

main().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
