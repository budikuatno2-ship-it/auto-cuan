'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getWibDate,
  isWeekend,
  getEffectiveLimit,
  checkQuota,
  incrementQuotaUsage
} = require('../lib/telegram-interactive-bot');

function withClock(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(iso);
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(fixed.getTime());
      return new RealDate(...args);
    }
    static now() {
      return fixed.getTime();
    }
  };
  try {
    return fn(fixed);
  } finally {
    global.Date = RealDate;
  }
}

function memoryDb(initial) {
  const rows = new Map((initial || []).map((row) => [String(row.telegram_id), Object.assign({}, row)]));
  return {
    rows,
    from() {
      function readQuery() {
        const filters = [];
        function find() {
          for (const row of rows.values()) {
            if (filters.every(([column, value]) => String(row[column]) === value)) {
              return Object.assign({}, row);
            }
          }
          return null;
        }
        const read = {
          select() { return read; },
          eq(column, value) {
            filters.push([column, String(value)]);
            return read;
          },
          maybeSingle() {
            return Promise.resolve({ data: find(), error: null });
          },
          then(resolve, reject) {
            return Promise.resolve({ data: find(), error: null }).then(resolve, reject);
          }
        };
        return read;
      }
      return {
        select() { return readQuery(); },
        update(patch) {
          return {
            eq(column, value) {
              for (const [key, row] of rows) {
                if (String(row[column]) === String(value)) {
                  rows.set(key, Object.assign({}, row, patch));
                  return Promise.resolve({ data: rows.get(key), error: null });
                }
              }
              return Promise.resolve({ data: null, error: null });
            }
          };
        }
      };
    }
  };
}

test('weekday effective limit stays at the stored daily limit', () => {
  withClock('2026-09-28T05:00:00Z', () => {
    assert.equal(isWeekend(), false);
    assert.equal(getEffectiveLimit({ daily_limit: 15 }), 15);
    assert.equal(getEffectiveLimit({}), 15);
  });
});

test('weekend effective limit rises to 20 even when stored limit is 15', () => {
  withClock('2026-09-26T05:00:00Z', () => {
    assert.equal(isWeekend(), true);
    assert.equal(getEffectiveLimit({ daily_limit: 15 }), 20);
    assert.equal(getEffectiveLimit({ daily_limit: 25 }), 25);
  });
});

test('quota resets when last usage date is not today in WIB', () => {
  withClock('2026-09-28T17:30:00Z', () => {
    const today = getWibDate();
    assert.equal(today, '2026-09-29');
    const quota = checkQuota({
      daily_limit: 15,
      daily_usage: 15,
      last_usage_date: '2026-09-28'
    });
    assert.equal(quota.allowed, true);
    assert.equal(quota.usage, 0);
    assert.equal(quota.remaining, 15);
  });
});

test('weekday quota blocks the 16th request and weekend quota allows it', () => {
  withClock('2026-09-25T05:00:00Z', () => {
    const weekday = checkQuota({
      daily_limit: 15,
      daily_usage: 15,
      last_usage_date: getWibDate()
    });
    assert.equal(weekday.allowed, false);
    assert.equal(weekday.remaining, 0);
  });

  withClock('2026-09-26T05:00:00Z', () => {
    const weekend = checkQuota({
      daily_limit: 15,
      daily_usage: 15,
      last_usage_date: getWibDate()
    });
    assert.equal(weekend.allowed, true);
    assert.equal(weekend.limit, 20);
    assert.equal(weekend.remaining, 5);
  });
});

test('increment resets a stale day then counts the next use on the same day', async () => {
  const today = getWibDate();
  const db = memoryDb([{
    telegram_id: '42',
    daily_usage: 9,
    last_usage_date: '2000-01-01'
  }]);
  const first = await incrementQuotaUsage(db, '42');
  assert.equal(first.ok, true);
  assert.equal(first.usage, 1);
  assert.equal(db.rows.get('42').last_usage_date, today);

  const second = await incrementQuotaUsage(db, '42');
  assert.equal(second.usage, 2);
  assert.equal(db.rows.get('42').daily_usage, 2);
});
