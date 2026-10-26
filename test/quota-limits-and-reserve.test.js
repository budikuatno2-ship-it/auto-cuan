'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('dynamic quota reserves read from env vars at runtime', () => {
  const arjumClient = require('../lib/arjum-client');

  const orig = {
    weekday: process.env.ARJUM_WEEKDAY_RESERVE,
    weekend: process.env.ARJUM_WEEKEND_RESERVE,
    postEod: process.env.ARJUM_POST_EOD_RESERVE,
    limit: process.env.ARJUM_DAILY_LIMIT
  };

  try {
    // Test 1: custom values
    process.env.ARJUM_WEEKDAY_RESERVE = '3000';
    process.env.ARJUM_WEEKEND_RESERVE = '500';
    process.env.ARJUM_POST_EOD_RESERVE = '100';
    process.env.ARJUM_DAILY_LIMIT = '25000';

    assert.equal(arjumClient.getArjumWeekdayReserve(), 3000, 'weekday reserve follows ARJUM_WEEKDAY_RESERVE=3000');
    assert.equal(arjumClient.getArjumWeekendReserve(), 500, 'weekend reserve follows ARJUM_WEEKEND_RESERVE=500');
    assert.equal(arjumClient.getArjumPostEodReserve(), 100, 'post-EOD reserve follows ARJUM_POST_EOD_RESERVE=100');
    assert.equal(arjumClient.getConfiguredPlanLimit(), 25000, 'daily limit follows ARJUM_DAILY_LIMIT=25000');

    // Test 2: defaults when env is unset
    delete process.env.ARJUM_WEEKDAY_RESERVE;
    delete process.env.ARJUM_WEEKEND_RESERVE;
    delete process.env.ARJUM_POST_EOD_RESERVE;
    delete process.env.ARJUM_DAILY_LIMIT;

    assert.equal(arjumClient.getArjumWeekdayReserve(), 5000, 'default weekday reserve = 5000');
    assert.equal(arjumClient.getArjumWeekendReserve(), 0, 'default weekend reserve = 0');
    assert.equal(arjumClient.getArjumPostEodReserve(), 0, 'default post-EOD reserve = 0');
  } finally {
    if (orig.weekday === undefined) delete process.env.ARJUM_WEEKDAY_RESERVE; else process.env.ARJUM_WEEKDAY_RESERVE = orig.weekday;
    if (orig.weekend === undefined) delete process.env.ARJUM_WEEKEND_RESERVE; else process.env.ARJUM_WEEKEND_RESERVE = orig.weekend;
    if (orig.postEod === undefined) delete process.env.ARJUM_POST_EOD_RESERVE; else process.env.ARJUM_POST_EOD_RESERVE = orig.postEod;
    if (orig.limit === undefined) delete process.env.ARJUM_DAILY_LIMIT; else process.env.ARJUM_DAILY_LIMIT = orig.limit;
  }
});

test('dynamic quota reserves: catchup budget and backfill reserve follow custom env', () => {
  const { computeCatchupBudget } = require('../tools/catchup-missing-dates');

  const orig = {
    weekday: process.env.ARJUM_WEEKDAY_RESERVE,
    weekend: process.env.ARJUM_WEEKEND_RESERVE
  };

  try {
    process.env.ARJUM_WEEKDAY_RESERVE = '3000';
    process.env.ARJUM_WEEKEND_RESERVE = '500';

    const wd = computeCatchupBudget(18080, 0, { isWeekend: false });
    assert.equal(wd.floor, 3000, 'weekday floor follows ARJUM_WEEKDAY_RESERVE=3000');
    assert.equal(wd.spendable, 18080 - 3000);

    const we = computeCatchupBudget(18080, 0, { isWeekend: true });
    assert.equal(we.floor, 500, 'weekend floor follows ARJUM_WEEKEND_RESERVE=500');
    assert.equal(we.spendable, 18080 - 500);
  } finally {
    if (orig.weekday === undefined) delete process.env.ARJUM_WEEKDAY_RESERVE; else process.env.ARJUM_WEEKDAY_RESERVE = orig.weekday;
    if (orig.weekend === undefined) delete process.env.ARJUM_WEEKEND_RESERVE; else process.env.ARJUM_WEEKEND_RESERVE = orig.weekend;
  }
});
