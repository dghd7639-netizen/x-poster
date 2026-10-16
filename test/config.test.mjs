import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '../server/config.mjs';

test('expandHome expands only ~ and ~/ prefixes', () => {
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/image.png'), join(homedir(), 'image.png'));
  assert.equal(expandHome('~someone/image.png'), '~someone/image.png');
});

test('environment defaults, disabled limits and invalid numeric fallback', async t => {
  const home = await mkdtemp(join(tmpdir(), 'x-poster-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const url = new URL('../server/config.mjs', import.meta.url).href;
  const run = settings => {
    const env = { ...process.env, X_POSTER_HOME: home };
    for (const key of ['X_POSTER_MIN_INTERVAL_SEC', 'X_POSTER_DAILY_LIMIT', 'X_POSTER_HEADLESS', 'X_POSTER_FOREGROUND', 'X_POSTER_CHROME_PATH', 'X_POSTER_TOOL_WAIT_SEC', 'X_POSTER_SHUTDOWN_GRACE_SEC', 'X_POSTER_BUSY_WAIT_SEC']) delete env[key];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {config} from ${JSON.stringify(url)}; console.log(JSON.stringify(config));`],
      { env: { ...env, ...settings }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout);
  };
  const defaults = run({});
  assert.equal(defaults.home, home);
  assert.equal(defaults.minIntervalSec, 60);
  assert.equal(defaults.dailyLimit, 20);
  assert.equal(defaults.headless, false);
  assert.equal(defaults.foreground, false);
  assert.equal(defaults.chromePath, null);
  assert.equal(defaults.toolWaitSec, 45);
  assert.equal(defaults.busyWaitSec, 15);
  assert.equal(defaults.shutdownGraceSec, 180);
  for (const value of ['-1', 'invalid', 'Infinity', '']) {
    const config = run({ X_POSTER_MIN_INTERVAL_SEC: value, X_POSTER_DAILY_LIMIT: value });
    assert.equal(config.minIntervalSec, 60);
    assert.equal(config.dailyLimit, 20);
  }
  const disabled = run({ X_POSTER_MIN_INTERVAL_SEC: '0', X_POSTER_DAILY_LIMIT: '0', X_POSTER_HEADLESS: 'YeS' });
  assert.equal(disabled.minIntervalSec, 0);
  assert.equal(disabled.dailyLimit, 0);
  assert.equal(disabled.headless, true);
  for (const value of ['1', 'true', 'YeS', 'ON']) assert.equal(run({ X_POSTER_FOREGROUND: value }).foreground, true);
  for (const value of ['0', 'false', 'no', 'off', '', 'invalid']) assert.equal(run({ X_POSTER_FOREGROUND: value }).foreground, false);
  for (const [value, expected] of [['0', 5], ['-1', 5], ['5', 5], ['90', 90], ['300', 300], ['999', 300],
    ['invalid', 45], ['Infinity', 45], ['', 45]]) {
    assert.equal(run({ X_POSTER_TOOL_WAIT_SEC: value }).toolWaitSec, expected);
  }
  for (const [value, expected] of [['0', 1], ['-1', 1], ['1', 1], ['30', 30], ['120', 120], ['999', 120],
    ['invalid', 15], ['Infinity', 15], ['', 15]]) {
    assert.equal(run({ X_POSTER_BUSY_WAIT_SEC: value }).busyWaitSec, expected);
  }
  assert.equal(run({ X_POSTER_SHUTDOWN_GRACE_SEC: '0' }).shutdownGraceSec, 0);
  assert.equal(run({ X_POSTER_SHUTDOWN_GRACE_SEC: '15' }).shutdownGraceSec, 15);
  assert.equal(run({ X_POSTER_SHUTDOWN_GRACE_SEC: '-1' }).shutdownGraceSec, 180);
});
