'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeMarkdownV2 } = require('../lib/telegram-notifier');

test('BUG-16: MarkdownV2 reserved character escaping for Telegram', async (t) => {
  await t.test('1. escapes all 18 Telegram MarkdownV2 reserved characters', () => {
    // Reserved characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
    const reservedChars = '_*[]()~`>#+-=|{}.!';
    const escaped = escapeMarkdownV2(reservedChars);

    for (const ch of reservedChars) {
      assert.ok(escaped.includes('\\' + ch), `Character ${ch} must be escaped with backslash`);
    }
  });

  await t.test('2. correctly escapes stock ticker signals, target prices, and reason text', () => {
    const rawReason = 'BBCA break-out at 9.500 (target: +5.5%! [alert])';
    const escaped = escapeMarkdownV2(rawReason);

    assert.equal(escaped, 'BBCA break\\-out at 9\\.500 \\(target: \\+5\\.5%\\! \\[alert\\]\\)');
  });

  await t.test('3. handles null, undefined, and empty string gracefully', () => {
    assert.equal(escapeMarkdownV2(null), '');
    assert.equal(escapeMarkdownV2(undefined), '');
    assert.equal(escapeMarkdownV2(''), '');
    assert.equal(escapeMarkdownV2('clean text 123'), 'clean text 123');
  });
});
