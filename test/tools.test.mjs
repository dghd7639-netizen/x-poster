import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, utimes, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, Page } from '../server/chrome.mjs';
import { XPosterError } from '../server/errors.mjs';

const home = await mkdtemp(join(tmpdir(), 'x-poster-tools-'));
process.env.X_POSTER_HOME = home;
delete process.env.X_POSTER_HEADLESS;
process.env.X_POSTER_CHROME_PATH = '/fake/chrome';
const { config, saveState, loadState } = await import('../server/config.mjs');
const { appendHistory, readHistory } = await import('../server/limits.mjs');
const { status, post, preview, login, exclusive, callTool, openUserWindow } = await import('../server/tools.mjs');
after(() => rm(home, { recursive: true, force: true }));

function plainWindow(t, fail = false) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.kill = () => assert.fail('The user window must not be killed');
  child.unref = () => assert.fail('The CLI must be able to wait for the user window');
  const spawned = t.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', ...(fail ? [new Error('spawn failed')] : [])));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawned.mock.restore(); syncBuiltinESMExports(); });
  return { child, spawned };
}

test('mutex keeps operations sequential and survives a rejection', async () => {
  const calls = [];
  let finish;
  const first = exclusive(async () => {
    calls.push('first');
    await new Promise(resolve => { finish = resolve; });
    throw new Error('expected');
  });
  const rejected = assert.rejects(first, /expected/);
  const second = exclusive(() => calls.push('second'));
  await Promise.resolve();
  assert.deepEqual(calls, ['first']);
  finish();
  await rejected;
  await second;
  assert.deepEqual(calls, ['first', 'second']);
});

test('input and wait_seconds fail before any browser work', async t => {
  const opened = t.mock.method(Browser, 'open', async () => { throw new Error('browser must not open'); });
  for (const args of [{}, { images: ['relative.png'] }, { text: false }]) {
    await assert.rejects(preview(args), error => error.code === 'INVALID_INPUT');
    await assert.rejects(post(args), error => error.code === 'INVALID_INPUT');
  }
  for (const wait_seconds of [-1, 301, 0.5, '1', null]) {
    await assert.rejects(login({ wait_seconds }), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(opened.mock.callCount(), 0);
});

test('status checks with a headless browser but reports the configured posting mode', async t => {
  assert.equal(config.headless, false);
  await saveState({ username: 'alice' });
  let loggedIn = true;
  let closed = 0;
  const opened = t.mock.method(Browser, 'open', async options => {
    assert.equal(options.profileDir, config.profileDir);
    assert.equal(options.headless, true);
    return { isLoggedIn: async () => loggedIn, isHeadless: async () => true, close: async () => closed++ };
  });
  const loggedInResult = (await status()).data;
  assert.equal(loggedInResult.username, 'alice');
  assert.equal(loggedInResult.headless, false);
  loggedIn = false;
  const result = (await status()).data;
  assert.equal(result.logged_in, false);
  assert.equal(result.headless, false);
  assert.equal(Object.hasOwn(result, 'username'), false);
  assert.equal(result.data_dir, home);
  assert.equal(result.login_window_open, false);
  assert.equal(closed, 2);
  assert.equal(opened.mock.callCount(), 2);
});

test('preview cleanup deletes only expired PNGs and leaves no history', async t => {
  await mkdir(config.previewsDir, { recursive: true });
  const oldPNG = join(config.previewsDir, 'old.png');
  const oldOther = join(config.previewsDir, 'old.txt');
  const recentPNG = join(config.previewsDir, 'recent.png');
  for (const file of [oldPNG, oldOther, recentPNG]) await writeFile(file, 'fixture');
  const old = new Date(Date.now() - 8 * 86400000);
  await utimes(oldPNG, old, old);
  await utimes(oldOther, old, old);
  let closed = false;
  t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => false, close: async () => { closed = true; },
  }));
  await assert.rejects(preview({ text: 'hello' }), error => error.code === 'NOT_LOGGED_IN');
  await assert.rejects(access(oldPNG), error => error.code === 'ENOENT');
  await access(oldOther);
  await access(recentPNG);
  assert.deepEqual(await readHistory(config.historyFile), []);
  assert.equal(closed, true);
});

test('ordinary login window is shared, blocks tools and checks cookies only after exit', async t => {
  let loggedIn = false;
  let closed = 0;
  const { child, spawned } = plainWindow(t);
  const opened = t.mock.method(Browser, 'open', async options => {
    assert.equal(options.headless, true);
    return {
      isLoggedIn: async () => loggedIn,
      close: async () => closed++,
    };
  });
  const first = openUserWindow();
  assert.equal(openUserWindow(), first);
  const window = await first;
  assert.equal(window.mode, 'login');
  const [executablePath, args, options] = spawned.mock.calls[0].arguments;
  assert.equal(executablePath, '/fake/chrome');
  assert.equal(args.at(-1), 'https://x.com/i/flow/login');
  assert.equal(args.some(arg => arg.startsWith('--remote-debugging')), false);
  assert.deepEqual(options, { stdio: 'ignore', detached: true });
  assert.equal(closed, 1);
  assert.equal(opened.mock.callCount(), 1);
  const waiting = (await login()).data;
  assert.equal(waiting.status, 'waiting_for_user');
  assert.match(waiting.message, /普通的 Chrome/);
  assert.match(waiting.message, /Cmd\+Q/);
  for (const action of [() => status(), () => preview({ text: 'hello' }), () => post({ text: 'hello' })]) {
    await assert.rejects(action(), error => {
      assert.equal(error.code, 'LOGIN_IN_PROGRESS');
      assert.equal(error.message, '登录窗口仍在运行。');
      assert.match(error.hint, /Cmd\+Q/);
      return true;
    });
  }
  assert.equal(opened.mock.callCount(), 1);
  const waitingForExit = login({ wait_seconds: 3 });
  loggedIn = true;
  child.emit('exit', 0);
  const result = await waitingForExit;
  assert.equal(result.data.status, 'logged_in');
  assert.equal(Object.hasOwn(result.data, 'username'), false);
  assert.equal(result.data.message, '登录成功，可以继续调用 x_status 或 x_preview。');
  assert.deepEqual(await window.done, { logged_in: true, reason: 'window_closed' });
  assert.equal(closed, 2);
  assert.equal(opened.mock.callCount(), 2);
  assert.equal((await status()).data.logged_in, true);
});

test('attention window also blocks tools until the process exits', async t => {
  let closed = 0;
  const { child, spawned } = plainWindow(t);
  t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => true,
    close: async () => closed++,
  }));
  const { mode, done } = await openUserWindow();
  assert.equal(mode, 'attention');
  assert.equal((await login()).data.status, 'window_open');
  assert.equal(spawned.mock.calls[0].arguments[1].at(-1), 'https://x.com/home');
  for (const action of [() => status(), () => preview({ text: 'hello' }), () => post({ text: 'hello' })]) {
    await assert.rejects(action(), error => error.code === 'LOGIN_IN_PROGRESS');
  }
  child.emit('exit', 0);
  assert.deepEqual(await done, { logged_in: true, reason: 'window_closed' });
  assert.equal(closed, 2);
});

test('wait_seconds expires without closing the ordinary window or imposing a login deadline', async t => {
  const { child } = plainWindow(t);
  let loggedIn = false;
  const opened = t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => loggedIn, close: async () => {} }));
  const first = openUserWindow();
  const { done } = await first;
  let finished = false;
  done.then(() => { finished = true; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = login({ wait_seconds: 1 });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.equal((await waiting).data.status, 'waiting_for_user');
  t.mock.timers.tick(10 * 60 * 1000);
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(openUserWindow(), first);
  assert.equal(opened.mock.callCount(), 1);
  loggedIn = true;
  child.emit('exit', 0);
  assert.deepEqual(await done, { logged_in: true, reason: 'window_closed' });
});

test('quitting without an X session reports window_closed, not a login success', async t => {
  const { child } = plainWindow(t);
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => false, close: async () => {} }));
  const { done } = await openUserWindow();
  const waiting = login({ wait_seconds: 3 });
  child.emit('exit', 0);
  assert.deepEqual(await done, { logged_in: false, reason: 'window_closed' });
  assert.deepEqual((await waiting).data, {
    logged_in: false, status: 'window_closed',
    message: '窗口已关闭，但没有检测到 X 登录状态。需要时请重新调用 x_login。',
  });
});

test('failed post-exit check clears the user window and allows a later status check', async t => {
  let checks = 0;
  let closed = 0;
  const { child } = plainWindow(t);
  t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => {
      if (checks++ === 1) throw new Error('check failed');
      return false;
    },
    close: async () => closed++,
  }));
  const { done } = await openUserWindow();
  const waiting = login({ wait_seconds: 3 });
  child.emit('exit', 0);
  assert.deepEqual(await done, { logged_in: false, reason: 'check_failed' });
  assert.deepEqual((await waiting).data, {
    logged_in: false, status: 'window_closed',
    message: '窗口已关闭，但没有检测到 X 登录状态。需要时请重新调用 x_login。',
  });
  assert.equal(closed, 2);
  assert.equal((await status()).data.logged_in, false);
});

test('failed plain-window spawn clears the in-flight state', async t => {
  plainWindow(t, true);
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => false, close: async () => {} }));
  await assert.rejects(openUserWindow(), error => error.code === 'BROWSER_NOT_FOUND');
  assert.equal((await status()).data.login_window_open, false);
});

test('UNCERTAIN is written to history and blocks the next post without opening a browser', async t => {
  let closed = false;
  const cdp = {
    send: async method => {
      if (method === 'Target.closeTarget') return {};
      throw new Error('Unexpected mock CDP command');
    },
  };
  const page = new Page(cdp, 'target', 'session');
  page.navigate = async () => { throw new XPosterError('UNCERTAIN', '模拟无法确认发布。'); };
  const opened = t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => true,
    newPage: async () => page,
    close: async () => { closed = true; },
  }));
  await assert.rejects(post({ text: 'hello' }), error => error.code === 'UNCERTAIN');
  const history = await readHistory(config.historyFile);
  assert.equal(history.length, 1);
  assert.equal(history[0].uncertain, true);
  assert.equal(history[0].text, 'hello');
  assert.equal(history[0].images, 0);
  assert.equal(closed, true);
  await assert.rejects(post({ text: 'hello again' }), error => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.toJSON().posts_last_24h, 1);
    assert.ok(error.toJSON().retry_after_sec > 0);
    return true;
  });
  assert.equal(opened.mock.callCount(), 1);
});

test('state tolerates broken JSON and preserves existing fields on save', async () => {
  await writeFile(config.stateFile, 'broken');
  assert.deepEqual(await loadState(), {});
  await saveState({ username: 'alice' });
  await saveState({ username: 'bob' });
  assert.deepEqual(await loadState(), { username: 'bob' });
  assert.equal(JSON.parse(await readFile(config.stateFile, 'utf8')).username, 'bob');
  await appendHistory(config.historyFile, { ts: 'not a timestamp' });
});

test('history failure cannot hide UNCERTAIN behind a retryable internal error', async t => {
  const original = config.historyFile;
  config.historyFile = join(home, 'history-error-test.jsonl');
  t.after(() => { config.historyFile = original; });
  const logged = t.mock.method(console, 'error', () => {});
  t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => true,
    newPage: async () => ({
      navigate: async () => {
        config.historyFile = home;
        throw new XPosterError('UNCERTAIN', '模拟无法确认发布。', { hint: '不要自动重试。' });
      },
      close: async () => {},
    }),
    close: async () => {},
  }));
  const result = await callTool('x_post', { text: 'hello' });
  assert.equal(JSON.parse(result.content[0].text).code, 'UNCERTAIN');
  assert.equal(logged.mock.callCount(), 1);
});

test('confirmed post survives username-state failure and is recorded before returning', async t => {
  const originalHistory = config.historyFile;
  const originalState = config.stateFile;
  config.historyFile = join(home, 'confirmed-test.jsonl');
  config.stateFile = join(home, 'state-directory');
  await mkdir(config.stateFile);
  t.after(() => { config.historyFile = originalHistory; config.stateFile = originalState; });
  const image = join(home, 'valid.png');
  await writeFile(image, 'fixture image');
  const logged = t.mock.method(console, 'error', () => {});
  const listeners = new Map();
  let snapshot = 0;
  let closed = false;
  let failHistory = false;
  t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => true,
    newPage: async () => ({
      navigate: async () => {},
      waitFor: async () => 'editor',
      setFiles: async () => {},
      call: async () => {
        snapshot++;
        if (snapshot <= 2) return { button: 'enabled', hasAttachments: true, uploading: false, toast: null };
        return snapshot === 3 ? null : 'alice';
      },
      screenshot: async () => {
        if (failHistory) config.historyFile = home;
        return Buffer.from('mock PNG');
      },
      send: async method => method === 'Network.getResponseBody' ? {
        body: JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '789' } } } } }),
      } : {},
      on: (method, listener) => { listeners.set(method, listener); return () => listeners.delete(method); },
      click: async () => {
        listeners.get('Network.responseReceived')({ requestId: 'r', response: { url: 'https://x.com/i/api/graphql/hash/CreatePost' } });
        listeners.get('Network.loadingFinished')({ requestId: 'r' });
      },
      close: async () => {},
    }),
    close: async () => { closed = true; },
  }));
  const result = (await post({ images: [image] })).data;
  assert.equal(result.posted, true);
  assert.equal(result.id, '789');
  assert.equal(result.url, 'https://x.com/alice/status/789');
  const history = await readHistory(config.historyFile);
  assert.equal(history[0].id, '789');
  assert.equal(history[0].images, 1);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(closed, true);
  config.historyFile = join(home, 'failed-confirmed-test.jsonl');
  failHistory = true;
  snapshot = 0;
  await assert.rejects(post({ images: [image] }), error => {
    assert.equal(error.code, 'UNCERTAIN');
    assert.match(error.message, /https:\/\/x.com\/alice\/status\/789/);
    assert.match(error.hint, /不要自动重试/);
    return true;
  });
  assert.equal(logged.mock.callCount(), 2);
});

test('callTool hides raw internal errors and writes diagnostic logs to stderr', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  t.mock.method(Browser, 'open', async () => { throw new Error('private transport details'); });
  const result = await callTool('x_status', {});
  const error = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.equal(error.ok, false);
  assert.equal(result.content[0].text.includes('private transport details'), false);
  assert.equal(logged.mock.callCount(), 1);
});
