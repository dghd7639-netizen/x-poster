import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI help and invalid inputs never need Chrome', async t => {
  const home = await mkdtemp(join(tmpdir(), 'x-poster-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = args => spawnSync(process.execPath,
    [fileURLToPath(new URL('../server/cli.mjs', import.meta.url)), ...args],
    { env: { ...process.env, X_POSTER_HOME: home }, encoding: 'utf8', timeout: 5000 });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /先预览/);
  assert.match(help.stdout, /scheduled/);
  assert.match(help.stdout, /--at/);
  assert.match(help.stdout, /cancel/);
  assert.match(help.stdout, /--id/);
  assert.match(help.stdout, /普通 Chrome/);
  assert.match(help.stdout, /Cmd\+Q/);
  assert.equal(help.stdout.includes('10 分钟'), false);
  assert.equal(help.stderr, '');
  for (const args of [['no-such-command'], ['preview'], ['post', '--image', 'relative.svg'], ['--bogus'], ['cancel'], ['cancel', '--id', 'no'], ['cancel', '--id', '1.2'], ['preview', '--id', '123'], ['schedule', '--text', 'hello'], ['schedule', '--text', 'hello', '--at', '2000-01-01T09:00'], ['preview', '--text', 'hello', '--at', 'bad'], ['post', '--text', 'hello', '--at', '2027-01-01T09:00']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'INVALID_INPUT');
  }
});
