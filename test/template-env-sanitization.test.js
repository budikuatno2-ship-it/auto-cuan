'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('BUG-15: Template env example sanitization', async (t) => {
  const exampleFile = path.join(__dirname, '..', 'deploy', 'vps', 'telegram-interactive-bot.env.example');
  const content = fs.readFileSync(exampleFile, 'utf8');

  await t.test('1. BOT_GROUP_ID does not expose internal numeric ID', () => {
    assert.doesNotMatch(content, /BOT_GROUP_ID=-1003755658635/, 'Must not leak the internal group ID');
    assert.match(content, /BOT_GROUP_ID=-100xxxxxxxxxx|<TELEGRAM_CHAT_ID>/, 'Must use placeholder');
  });

  await t.test('2. Checks all .env.example files for absence of internal numeric ID', () => {
    const deployDir = path.join(__dirname, '..', 'deploy', 'vps');
    const files = fs.readdirSync(deployDir).filter(f => f.endsWith('.env.example'));
    for (const f of files) {
      const c = fs.readFileSync(path.join(deployDir, f), 'utf8');
      assert.ok(!c.includes('3755658635'), `File ${f} must not leak internal ID`);
    }
  });
});
