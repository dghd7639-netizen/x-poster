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

async function queuedCLI(t, body) {
  const home = await mkdtemp(join(tmpdir(), 'x-poster-cli-queue-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const chrome = new URL('../server/chrome.mjs', import.meta.url).href;
  const tools = new URL('../server/tools.mjs', import.meta.url).href;
  const preload = `
    import { Browser } from ${JSON.stringify(chrome)};
    import { exclusive } from ${JSON.stringify(tools)};
    import { mock } from 'node:test';
    Browser.open = async () => ({ isLoggedIn: async () => false, close: async () => {} });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    ${body}
    await started;
  `;
  return spawnSync(process.execPath, ['--no-warnings', '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../server/cli.mjs', import.meta.url)), 'status'], { env: { ...process.env, X_POSTER_HOME: home, X_POSTER_BUSY_WAIT_SEC: '1' }, encoding: 'utf8', timeout: 4000 });
}

test('CLI waits beyond the synchronous limit and prints its waiting message only once to stderr', { timeout: 4500 }, async t => {
  const result = await queuedCLI(t, `
    void exclusive(async () => { entered(); await new Promise(resolve => setTimeout(resolve, 1100)); });
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).logged_in, false);
  assert.equal(result.stderr.split('正在等待空闲').length - 1, 1);
  assert.match(result.stderr, /最多 10 分钟.*尚未执行/);
});

test('CLI stops waiting at ten simulated minutes with BUSY and never opens Chrome', { timeout: 2000 }, async t => {
  const result = await queuedCLI(t, `
    void exclusive(async () => { entered(); await new Promise(() => {}); });
    await started;
    mock.timers.enable({ apis: ['setTimeout'] });
    Browser.open = async () => { throw new Error('expired operation must never open a browser'); };
    const report = console.error;
    console.error = (...args) => {
      report(...args);
      setImmediate(() => mock.timers.tick(600000));
    };
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.split('正在等待空闲').length - 1, 1);
  const error = JSON.parse(result.stderr.slice(result.stderr.indexOf('{')));
  assert.equal(error.code, 'BUSY');
  assert.match(error.hint, /安全重试/);
});
