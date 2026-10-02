'use strict';

// BUG-RT-01 regression — watchdog executability invariant.
//
// The canonical schedule (deploy/vps/final-schedule.cron) invokes several
// scripts DIRECTLY (no `bash`/`node` prefix). A normal `git clone`/`git pull`
// only restores the executable bit from the Git index, so any directly invoked
// tracked script MUST be staged as mode 100755. check-verify-poller.sh was
// staged 100644, so cron logged `Permission denied` every 5 minutes.
//
// This test reads the ACTUAL git index modes (not a regex over the file) and
// cross-checks them against the ACTUAL cron invocation form.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CRON_PATH = path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron');
const DEPLOY_PREFIX = '/home/ubuntu/auto-cuan/';

function readIndexModes() {
  const res = spawnSync('git', ['ls-files', '--stage', '--', 'deploy/vps'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(res.status, 0, 'git ls-files must succeed: ' + res.stderr);
  const modes = new Map();
  for (const line of res.stdout.split('\n')) {
    // Format: <mode> <sha> <stage>\t<path>
    const match = line.match(/^(\d{6})\s+\S+\s+\d+\t(.+)$/);
    if (match) modes.set(match[2].trim(), match[1]);
  }
  return modes;
}

function activeCronLines() {
  return fs.readFileSync(CRON_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('CRON_TZ'));
}

function commandOf(cronLine) {
  // 5 schedule fields, then the command.
  const match = cronLine.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/);
  return match ? match[1].trim() : '';
}

function directExecTargets() {
  const targets = [];
  for (const line of activeCronLines()) {
    const command = commandOf(line);
    if (!command) continue;
    const firstToken = command.split(/\s+/)[0];
    if (!firstToken.endsWith('.sh')) continue; // node / bash wrappers are fine
    if (!firstToken.startsWith(DEPLOY_PREFIX)) continue; // only repo scripts
    targets.push({ command, scriptRel: firstToken.slice(DEPLOY_PREFIX.length) });
  }
  return targets;
}

test('RT-01: every directly invoked cron shell script is staged executable (100755)', () => {
  const modes = readIndexModes();
  const targets = directExecTargets();

  assert.ok(targets.length > 0, 'expected at least one direct .sh invocation in the schedule');
  for (const { command, scriptRel } of targets) {
    const mode = modes.get(scriptRel);
    assert.ok(mode, 'directly invoked script is not tracked: ' + scriptRel);
    assert.equal(
      mode,
      '100755',
      scriptRel + ' is invoked directly by cron but staged mode ' + mode +
      ' — a normal git checkout would restore it non-executable (command: ' + command + ')'
    );
  }
});

test('RT-01: check-verify-poller.sh is staged 100755 and invoked directly by cron', () => {
  const modes = readIndexModes();
  assert.equal(
    modes.get('deploy/vps/check-verify-poller.sh'),
    '100755',
    'the verify-bot watchdog must carry the executable bit in the Git index'
  );

  const direct = directExecTargets().some((t) => t.scriptRel === 'deploy/vps/check-verify-poller.sh');
  assert.equal(direct, true, 'cron must invoke the watchdog directly (no bash prefix)');
});

test('RT-01: bash-wrapped scripts are exempt (invocation form decides)', () => {
  const modes = readIndexModes();
  // run-daily-market-update.sh is invoked via `bash ...` and stays 100644 —
  // that is safe and must not be flagged by the invariant above.
  const wrapped = activeCronLines().filter((line) =>
    line.includes('run-daily-market-update.sh')
  );
  assert.ok(wrapped.length > 0, 'expected the EOD queue line');
  assert.match(wrapped[0], /bash\s+\/home\/ubuntu\/auto-cuan\/deploy\/vps\/run-daily-market-update\.sh/);
  assert.equal(modes.get('deploy/vps/run-daily-market-update.sh'), '100644');
  assert.equal(
    directExecTargets().some((t) => t.scriptRel === 'deploy/vps/run-daily-market-update.sh'),
    false,
    'bash-wrapped scripts must not be treated as direct-exec targets'
  );
});
