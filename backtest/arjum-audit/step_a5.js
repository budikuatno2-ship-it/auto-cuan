'use strict';
const bandarmologiService = require('/home/ubuntu/auto-cuan/lib/bandarmologi-service');

async function checkWeb() {
  console.log('=== TEST 1: BBCA (Saham dengan file F ASLI) ===');
  const bbcaAll = await bandarmologiService.getBandarmologiData('BBCA', { date: '2026-10-16', flow: 'all' });
  const bbcaF = await bandarmologiService.getBandarmologiData('BBCA', { date: '2026-10-16', flow: 'F' });
  
  const bbcaAllBuy = (bbcaAll.broker_summary.gross_buyers || []).reduce((a, b) => a + Number(b.bval || b.buy_val || 0), 0);
  const bbcaFBuy = (bbcaF.broker_summary.gross_buyers || []).reduce((a, b) => a + Number(b.bval || b.buy_val || 0), 0);
  console.log({
    ticker: 'BBCA',
    date: '2026-10-16',
    all_buy_val: bbcaAllBuy,
    foreign_buy_val: bbcaFBuy,
    isEqual: bbcaAllBuy === bbcaFBuy,
    note: bbcaAllBuy === bbcaFBuy ? 'ASING = SEMUA (SALAH)' : 'ASING != SEMUA (BENAR / BERBEDA)'
  });

  console.log('\n=== TEST 2: AALI (Saham dengan file F TERCEMAR flow=all) ===');
  const aaliAll = await bandarmologiService.getBandarmologiData('AALI', { date: '2026-10-16', flow: 'all' });
  const aaliF = await bandarmologiService.getBandarmologiData('AALI', { date: '2026-10-16', flow: 'F' });

  const aaliAllBuy = (aaliAll.broker_summary.gross_buyers || []).reduce((a, b) => a + Number(b.bval || b.buy_val || 0), 0);
  const aaliFBuy = (aaliF.broker_summary.gross_buyers || []).reduce((a, b) => a + Number(b.bval || b.buy_val || 0), 0);
  console.log({
    ticker: 'AALI',
    date: '2026-10-16',
    all_buy_val: aaliAllBuy,
    foreign_buy_val: aaliFBuy,
    isEqual: aaliAllBuy === aaliFBuy,
    note: aaliAllBuy === aaliFBuy ? 'ASING = SEMUA (TERBUKTI TERCEMAR KARENA MEMBACA FILE DENGAN flow=all)' : 'ASING != SEMUA'
  });
}

checkWeb().catch(console.error);
