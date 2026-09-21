'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.APP_SECRET = 'test-secret-at-least-32-chars-long-12345';

const {
  saveUserApiKey,
  isSubscribedTier,
  clearMemoryStoreForTesting
} = require('../lib/user-ai-credentials');

test('BUG-UAC-01: saveUserApiKey rejects undefined or empty userId', async () => {
  clearMemoryStoreForTesting();
  const validKey = 'AIzaSyD-12345678901234567890';
  const res = await saveUserApiKey(null, undefined, validKey, 'gemini');
  assert.strictEqual(res.ok, false, 'saveUserApiKey should reject undefined userId');
});

test('BUG-UAC-02: isSubscribedTier recognizes active recurring subscriber (pro/vip)', () => {
  const access = {
    user: { id: 'user-1', username: 'trader' },
    entitlement: {
      status: 'active',
      current_plan: 'pro'
    }
  };
  const isSub = isSubscribedTier(access);
  assert.strictEqual(isSub, true, 'Active recurring subscriber should be recognized as subscribed tier');
});
