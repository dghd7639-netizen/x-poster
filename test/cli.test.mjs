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
  assert.match(help.stdout, /article-draft/);
  assert.match(help.stdout, /article-cover/);
  assert.match(help.stdout, /article-publish/);
  assert.match(help.stdout, /article-delete/);
  assert.match(help.stdout, /--cover/);
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
  for (const args of [['article-draft'], ['article-draft', '--file', './missing.md'], ['article-draft', '--file', './bad.txt'],
    ['article-publish'], ['article-delete', '--id', '123\n'], ['article-publish', '--id', 'no'],
    ['article-draft', '--file', './missing.md', '--text', 'ignored'], ['article-delete', '--id', '123', '--cover', './a.png'],
    ['article-cover'], ['article-cover', '--id', 'abc', '--cover', './cover.png'],
    ['article-cover', '--id', '123'], ['article-cover', '--id', '123', '--cover', './cover.gif'],
    ['article-cover', '--id', '123', '--cover', './missing.png'],
    ['article-cover', '--id', '123', '--file', './article.md'],
    ['article-cover', '--id', '123', '--cover', './cover.png', '--title', 'ignored'],
    ['preview', '--file', './a.md']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'INVALID_INPUT');
  }
  const relative = run(['article-cover', '--id', '123', '--cover', './missing.png']);
  assert.match(JSON.parse(relative.stderr).message, /不存在或无法读取/);
});
