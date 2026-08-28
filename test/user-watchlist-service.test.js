'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const watchlistService = require('../lib/user-watchlist-service');

test('normalizeTicker cleans and validates ticker format', () => {
  assert.equal(watchlistService.normalizeTicker('bbca'), 'BBCA');
  assert.equal(watchlistService.normalizeTicker(' TLKM '), 'TLKM');
  assert.equal(watchlistService.normalizeTicker('BRIS'), 'BRIS');
  assert.equal(watchlistService.normalizeTicker(''), null);
  assert.equal(watchlistService.normalizeTicker('TOOLONGTICKER'), null);
  assert.equal(watchlistService.normalizeTicker('BB CA'), null);
  assert.equal(watchlistService.normalizeTicker(null), null);
});

test('addToWatchlist validates input and upserts ticker', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  let upserted = null;

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'app_user_watchlists');
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle() {
                      return Promise.resolve({ data: null, error: null });
                    }
                  };
                }
              };
            }
          };
        },
        upsert(payload) {
          upserted = payload;
          return {
            select() {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: { id: 'wl-1', ...payload }, error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const res = await watchlistService.addToWatchlist(mockSupabase, userId, 'bbca', 'Catatan BBCA');
  assert.equal(res.success, true);
  assert.equal(res.item.ticker, 'BBCA');
  assert.equal(upserted.ticker, 'BBCA');
  assert.equal(upserted.notes, 'Catatan BBCA');

  // Invalid ticker check
  const badRes = await watchlistService.addToWatchlist(mockSupabase, userId, 'invalid-ticker');
  assert.equal(badRes.success, false);
  assert.match(badRes.error, /Ticker tidak valid/);
});

test('addToWatchlist: re-add existing ticker without new notes preserves old notes (does not overwrite with null)', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  let upsertPayload = null;

  const existingRow = {
    id: 'wl-existing-1',
    user_id: userId,
    ticker: 'BBCA',
    notes: 'Catatan lama yang sangat berharga'
  };

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'app_user_watchlists');
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle() {
                      return Promise.resolve({ data: existingRow, error: null });
                    }
                  };
                }
              };
            }
          };
        },
        upsert(payload) {
          upsertPayload = payload;
          // In actual Postgres, omitted keys keep their existing DB values
          const merged = { ...existingRow, ...payload };
          return {
            select() {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: merged, error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  // Re-add without notes (notes = null or not provided)
  const res = await watchlistService.addToWatchlist(mockSupabase, userId, 'BBCA');
  assert.equal(res.success, true);
  // Payload must NOT contain notes key so DB row notes are untouched
  assert.equal(Object.prototype.hasOwnProperty.call(upsertPayload, 'notes'), false);
  assert.equal(upsertPayload.ticker, 'BBCA');
  assert.equal(res.item.notes, 'Catatan lama yang sangat berharga');
});

test('addToWatchlist: re-add existing ticker with new notes updates notes', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  let upsertPayload = null;

  const existingRow = {
    id: 'wl-existing-1',
    user_id: userId,
    ticker: 'TLKM',
    notes: 'Catatan lama'
  };

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'app_user_watchlists');
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle() {
                      return Promise.resolve({ data: existingRow, error: null });
                    }
                  };
                }
              };
            }
          };
        },
        upsert(payload) {
          upsertPayload = payload;
          const merged = { ...existingRow, ...payload };
          return {
            select() {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: merged, error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const res = await watchlistService.addToWatchlist(mockSupabase, userId, 'TLKM', 'Catatan baru diupdate');
  assert.equal(res.success, true);
  assert.equal(Object.prototype.hasOwnProperty.call(upsertPayload, 'notes'), true);
  assert.equal(upsertPayload.notes, 'Catatan baru diupdate');
  assert.equal(res.item.notes, 'Catatan baru diupdate');
});

test('addToWatchlist: add completely new ticker stores notes normally (even when null)', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  let upsertPayload = null;

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'app_user_watchlists');
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle() {
                      return Promise.resolve({ data: null, error: null });
                    }
                  };
                }
              };
            }
          };
        },
        upsert(payload) {
          upsertPayload = payload;
          return {
            select() {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: { id: 'wl-new-1', ...payload }, error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  // 1. New ticker with null notes
  const res1 = await watchlistService.addToWatchlist(mockSupabase, userId, 'ASII');
  assert.equal(res1.success, true);
  assert.equal(Object.prototype.hasOwnProperty.call(upsertPayload, 'notes'), true);
  assert.equal(upsertPayload.notes, null);

  // 2. New ticker with initial notes
  const res2 = await watchlistService.addToWatchlist(mockSupabase, userId, 'UNTR', 'Catatan awal UNTR');
  assert.equal(res2.success, true);
  assert.equal(upsertPayload.notes, 'Catatan awal UNTR');
});

test('removeFromWatchlist deletes watchlist item and cascades alerts', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  let deletedFromWl = false;
  let deletedFromAlerts = false;

  const mockSupabase = {
    from(table) {
      if (table === 'app_user_watchlists') {
        return {
          delete() {
            return {
              eq(col1, val1) {
                return {
                  eq(col2, val2) {
                    deletedFromWl = true;
                    return Promise.resolve({ error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'app_user_alerts') {
        return {
          delete() {
            return {
              eq(col1, val1) {
                return {
                  eq(col2, val2) {
                    deletedFromAlerts = true;
                    return Promise.resolve({ error: null });
                  }
                };
              }
            };
          }
        };
      }
    }
  };

  const res = await watchlistService.removeFromWatchlist(mockSupabase, userId, 'BBCA');
  assert.equal(res.success, true);
  assert.equal(res.ticker, 'BBCA');
  assert.equal(deletedFromWl, true);
  assert.equal(deletedFromAlerts, true);
});

test('createAlert validates condition_type and target_price correctly', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  const mockSupabase = {
    from(table) {
      if (table === 'app_user_telegram_verifications') {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { telegram_private_chat_id: 123456789 }, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'app_user_alerts') {
        return {
          insert(payload) {
            return {
              select() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { id: 'alert-101', ...payload }, error: null });
                  }
                };
              }
            };
          }
        };
      }
    }
  };

  // 1. Success case: PRICE_ABOVE with valid price
  const res1 = await watchlistService.createAlert(mockSupabase, userId, {
    ticker: 'BBCA',
    condition_type: 'PRICE_ABOVE',
    target_price: 10500
  });
  assert.equal(res1.success, true);
  assert.equal(res1.alert.ticker, 'BBCA');
  assert.equal(res1.alert.target_price, 10500);
  assert.equal(res1.alert.notification_chat_id, 123456789);

  // 2. Failure case: Invalid condition type
  const res2 = await watchlistService.createAlert(mockSupabase, userId, {
    ticker: 'BBCA',
    condition_type: 'INVALID_CONDITION'
  });
  assert.equal(res2.success, false);
  assert.match(res2.error, /condition_type tidak valid/);

  // 3. Failure case: Missing price on PRICE_BELOW
  const res3 = await watchlistService.createAlert(mockSupabase, userId, {
    ticker: 'BBCA',
    condition_type: 'PRICE_BELOW',
    target_price: null
  });
  assert.equal(res3.success, false);
  assert.match(res3.error, /target_price harus berupa angka positif/);
});

test('deleteAlert removes alert by ID and user ID', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  let deletedAlertId = null;

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'app_user_alerts');
      return {
        delete() {
          return {
            eq(col1, val1) {
              return {
                eq(col2, val2) {
                  deletedAlertId = val1;
                  return Promise.resolve({ error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const res = await watchlistService.deleteAlert(mockSupabase, userId, 'alert-999');
  assert.equal(res.success, true);
  assert.equal(res.alert_id, 'alert-999');
  assert.equal(deletedAlertId, 'alert-999');
});

test('getUserWatchlist retrieves watchlist items with enriched prices and alerts', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  const mockWl = [
    { id: 'wl-1', ticker: 'BBCA', notes: 'Core holding', created_at: '2026-08-27T01:00:00Z', updated_at: '2026-08-27T01:00:00Z' },
    { id: 'wl-2', ticker: 'ASII', notes: null, created_at: '2026-08-27T02:00:00Z', updated_at: '2026-08-27T02:00:00Z' }
  ];

  const mockAlerts = [
    { id: 'al-1', ticker: 'BBCA', condition_type: 'PRICE_ABOVE', target_price: 10500, is_active: true }
  ];

  const mockPrices = [
    { ticker: 'BBCA', last_price: 10200, change_pct: 2.5, calculated_at: '2026-08-27T03:00:00Z' },
    { ticker: 'ASII', last_price: 5050, change_pct: -0.5, calculated_at: '2026-08-27T03:00:00Z' }
  ];

  const mockSupabase = {
    from(table) {
      if (table === 'app_user_watchlists') {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return Promise.resolve({ data: mockWl, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'app_user_alerts') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return Promise.resolve({ data: mockAlerts, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'daytrade_screener_latest') {
        return {
          select() {
            return {
              in() {
                return Promise.resolve({ data: mockPrices, error: null });
              }
            };
          }
        };
      }
    }
  };

  const res = await watchlistService.getUserWatchlist(mockSupabase, userId);
  assert.equal(res.success, true);
  assert.equal(res.watchlist.length, 2);

  const bbca = res.watchlist.find(w => w.ticker === 'BBCA');
  assert.equal(bbca.last_price, 10200);
  assert.equal(bbca.change_pct, 2.5);
  assert.equal(bbca.alerts.length, 1);
  assert.equal(bbca.alerts[0].condition_type, 'PRICE_ABOVE');

  const asii = res.watchlist.find(w => w.ticker === 'ASII');
  assert.equal(asii.last_price, 5050);
  assert.equal(asii.alerts.length, 0);
});

function requireSectorHotWithStub() {
  const origLoad = Module._load;
  const abs = require.resolve('../api/sector-hot');
  delete require.cache[abs];
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') {
      return {
        createClient: function () {
          return {};
        }
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../api/sector-hot');
  } finally {
    Module._load = origLoad;
  }
}

test('handleUserWatchlist rejects unauthenticated session', async () => {
  const sectorHot = requireSectorHotWithStub();
  const handler = sectorHot.__test && sectorHot.__test.handleUserWatchlist;
  assert.equal(typeof handler, 'function');

  let statusCode = 0;
  let jsonResult = null;
  const mockReq = { method: 'GET', query: { action: 'watchlist' }, headers: {} };
  const mockRes = {
    status(c) { statusCode = c; return this; },
    json(obj) { jsonResult = obj; return this; }
  };

  await handler(mockReq, mockRes, {});
  assert.equal(statusCode, 200);
  assert.equal(jsonResult.success, false);
  assert.match(jsonResult.error, /Autentikasi diperlukan|Login diperlukan|Sesi tidak valid/);
});