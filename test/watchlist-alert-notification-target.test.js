'use strict';

/**
 * Where a watchlist alert is allowed to be delivered.
 *
 * createAlert() receives the HTTP request body verbatim
 * (api/sector-hot.js:8098 — `var payload = req.body || {};`) and used the
 * caller's own `notification_chat_id` when one was present, falling back to the
 * user's verified Telegram binding only when it was absent.
 *
 * The stored value is what the dispatcher sends to
 * (evaluateActiveUserAlerts -> telegramNotifier.sendTelegramMessage with
 * `chat_id: alert.notification_chat_id`), and that notifier is the MAIN
 * Auto-Cuan bot. So a signed-in user could point their own alert at somebody
 * else's private chat and have the product's bot deliver messages there on a
 * schedule.
 *
 * The destination is not the caller's to choose: it is a property of the
 * account, resolvable server-side. `watchlist_id` is the same class of input —
 * a foreign key accepted from the request with no ownership check.
 *
 * The real client sends only ticker / condition_type / target_price
 * (public/watchlist-runtime.js:275-279), so neither field has a legitimate
 * caller.
 */

const test = require('node:test');
const assert = require('node:assert');

const service = require('../lib/user-watchlist-service');

const OWNER = 'user-owner-1';
const OWNER_CHAT_ID = 111111;
const ATTACKER_TARGET_CHAT_ID = 999999;

/**
 * Supabase double covering exactly the reads/writes createAlert performs.
 * `verifiedChatId` null means the user has no Telegram binding.
 * `ownedWatchlistIds` are the watchlist rows that belong to OWNER.
 */
function fakeSupabase(opts) {
  opts = opts || {};
  const state = { inserted: null };
  const verifiedChatId = Object.prototype.hasOwnProperty.call(opts, 'verifiedChatId')
    ? opts.verifiedChatId : OWNER_CHAT_ID;
  const ownedWatchlistIds = opts.ownedWatchlistIds || [];

  return {
    state,
    from(table) {
      if (table === 'app_user_telegram_verifications') {
        return {
          select() {
            return {
              eq(col, val) {
                assert.strictEqual(col, 'user_id');
                return {
                  maybeSingle() {
                    if (val !== OWNER || verifiedChatId == null) return Promise.resolve({ data: null, error: null });
                    return Promise.resolve({ data: { telegram_private_chat_id: verifiedChatId }, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'app_user_watchlists') {
        return {
          select() {
            const filters = {};
            const chain = {
              eq(col, val) { filters[col] = val; return chain; },
              maybeSingle() {
                const owns = filters.user_id === OWNER && ownedWatchlistIds.indexOf(filters.id) >= 0;
                return Promise.resolve({ data: owns ? { id: filters.id } : null, error: null });
              }
            };
            return chain;
          }
        };
      }
      if (table === 'app_user_alerts') {
        return {
          insert(record) {
            state.inserted = record;
            return {
              select() {
                return { maybeSingle() { return Promise.resolve({ data: Object.assign({ id: 'alert-1' }, record), error: null }); } };
              }
            };
          }
        };
      }
      throw new Error('unexpected table ' + table);
    }
  };
}

const BASE = { ticker: 'BBCA', condition_type: 'PRICE_ABOVE', target_price: 9500 };

test('1. a caller-supplied notification_chat_id is ignored', async () => {
  const db = fakeSupabase();
  const out = await service.createAlert(db, OWNER, Object.assign({}, BASE, {
    notification_chat_id: ATTACKER_TARGET_CHAT_ID
  }));
  assert.strictEqual(out.success, true);
  assert.strictEqual(
    db.state.inserted.notification_chat_id, OWNER_CHAT_ID,
    'the alert must be delivered to the account own verified chat, never to a chat id chosen by the request'
  );
});

test('2. with no verified Telegram binding the destination stays null, not the caller value', async () => {
  const db = fakeSupabase({ verifiedChatId: null });
  const out = await service.createAlert(db, OWNER, Object.assign({}, BASE, {
    notification_chat_id: ATTACKER_TARGET_CHAT_ID
  }));
  assert.strictEqual(out.success, true);
  assert.strictEqual(
    db.state.inserted.notification_chat_id, null,
    'no binding means no destination — it must never fall back to the requested chat id'
  );
});

test('3. a string-shaped chat id in the body is ignored too', async () => {
  const db = fakeSupabase();
  await service.createAlert(db, OWNER, Object.assign({}, BASE, {
    notification_chat_id: String(ATTACKER_TARGET_CHAT_ID)
  }));
  assert.strictEqual(db.state.inserted.notification_chat_id, OWNER_CHAT_ID);
});

test('4. the normal client payload still resolves the right destination', async () => {
  const db = fakeSupabase();
  const out = await service.createAlert(db, OWNER, Object.assign({}, BASE));
  assert.strictEqual(out.success, true);
  assert.strictEqual(db.state.inserted.notification_chat_id, OWNER_CHAT_ID);
  assert.strictEqual(db.state.inserted.ticker, 'BBCA');
  assert.strictEqual(db.state.inserted.condition_type, 'PRICE_ABOVE');
  assert.strictEqual(db.state.inserted.target_price, 9500);
  assert.strictEqual(db.state.inserted.user_id, OWNER);
});

test('5. a watchlist_id the caller does not own is not stored', async () => {
  const db = fakeSupabase({ ownedWatchlistIds: ['wl-mine'] });
  const out = await service.createAlert(db, OWNER, Object.assign({}, BASE, {
    watchlist_id: 'wl-belongs-to-someone-else'
  }));
  assert.strictEqual(out.success, true);
  assert.strictEqual(
    db.state.inserted.watchlist_id, null,
    'a foreign key from the request body must be proven to belong to the caller'
  );
});

test('6. a watchlist_id the caller does own is preserved', async () => {
  const db = fakeSupabase({ ownedWatchlistIds: ['wl-mine'] });
  await service.createAlert(db, OWNER, Object.assign({}, BASE, { watchlist_id: 'wl-mine' }));
  assert.strictEqual(db.state.inserted.watchlist_id, 'wl-mine');
});

test('7. validation of ticker and condition is unchanged', async () => {
  const db = fakeSupabase();
  assert.strictEqual((await service.createAlert(db, OWNER, { ticker: '!!', condition_type: 'PRICE_ABOVE', target_price: 1 })).success, false);
  assert.strictEqual((await service.createAlert(db, OWNER, { ticker: 'BBCA', condition_type: 'NOPE', target_price: 1 })).success, false);
  assert.strictEqual((await service.createAlert(db, OWNER, { ticker: 'BBCA', condition_type: 'PRICE_ABOVE' })).success, false);
});
