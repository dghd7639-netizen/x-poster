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
const { status, post, preview, schedule, listScheduled, cancelScheduled, login, exclusive, callTool, openUserWindow,
  articleDraft, articleCover, articlePublish, articleDelete, pendingWork, waitForShutdown } = await import('../server/tools.mjs');
const articlePath = join(home, 'article.md');
await writeFile(articlePath, '# Title\n正文');
const articleCoverPath = join(home, 'cover.png');
await writeFile(articleCoverPath, 'image');
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

test('shutdown waits for the entire browser queue, including rejected work', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release;
  const first = exclusive(() => new Promise(resolve => { release = resolve; }));
  const second = exclusive(() => { throw new XPosterError('UNCERTAIN', '模拟失败。'); });
  const rejected = assert.rejects(second, error => error.code === 'UNCERTAIN');
  let stopped = false;
  const shutdown = waitForShutdown().then(() => { stopped = true; });
  await Promise.resolve();
  t.mock.timers.tick(179000);
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await first;
  await rejected;
  await shutdown;
  assert.equal(stopped, true);
  await pendingWork();
});

test('shutdown grace deadline bounds a stuck job without cancelling it', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const original = config.shutdownGraceSec;
  config.shutdownGraceSec = 2;
  t.after(() => { config.shutdownGraceSec = original; });
  let release;
  let finished = false;
  const work = exclusive(() => new Promise(resolve => { release = resolve; })).then(() => { finished = true; });
  const shutdown = waitForShutdown();
  await Promise.resolve();
  t.mock.timers.tick(2000);
  await shutdown;
  assert.equal(finished, false);
  release();
  await work;
  assert.equal(finished, true);
});

test('input and wait_seconds fail before any browser work', async t => {
  const opened = t.mock.method(Browser, 'open', async () => { throw new Error('browser must not open'); });
  for (const args of [{}, { images: ['relative.png'] }, { text: false }]) {
    await assert.rejects(preview(args), error => error.code === 'INVALID_INPUT');
    await assert.rejects(post(args), error => error.code === 'INVALID_INPUT');
  }
  for (const args of [{ text: 'hello' }, { text: 'hello', scheduled_at: '2000-01-01T09:00' }]) {
    await assert.rejects(schedule(args), error => error.code === 'INVALID_INPUT');
  }
  for (const args of [undefined, {}, null, [], { id: 123 }, { id: 'no' }, { id: '' }, { id: '123\n' }, { id: '123', extra: true }]) {
    assert.throws(() => cancelScheduled(args), error => error.code === 'INVALID_INPUT');
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
  for (const action of [() => status(), () => preview({ text: 'hello' }), () => post({ text: 'hello' }), () => schedule({ text: 'hello', scheduled_at: new Date(Date.now() + 86400000).toISOString() }), () => listScheduled(), () => cancelScheduled({ id: '123' }), () => articleDraft({ markdown_path: articlePath }), () => articleCover({ article_id: '123', cover: articleCoverPath }), () => articlePublish({ article_id: '123' }), () => articleDelete({ article_id: '123' })]) {
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
  for (const action of [() => status(), () => preview({ text: 'hello' }), () => post({ text: 'hello' }), () => schedule({ text: 'hello', scheduled_at: new Date(Date.now() + 86400000).toISOString() }), () => listScheduled(), () => cancelScheduled({ id: '123' }), () => articleDraft({ markdown_path: articlePath }), () => articleCover({ article_id: '123', cover: articleCoverPath }), () => articlePublish({ article_id: '123' }), () => articleDelete({ article_id: '123' })]) {
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


test('new tools reject unauthenticated sessions and close the browser', async t => {
  const originalHistory = config.historyFile;
  config.historyFile = join(home, 'not-logged-schedule.jsonl');
  t.after(() => { config.historyFile = originalHistory; });
  let closed = 0;
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => false, close: async () => closed++ }));
  for (const action of [() => schedule({ text: 'hello', scheduled_at: new Date(Date.now() + 86400000).toISOString() }), () => listScheduled(), () => cancelScheduled({ id: '123' }), () => articleDraft({ markdown_path: articlePath }), () => articleCover({ article_id: '123', cover: articleCoverPath }), () => articlePublish({ article_id: '123' }), () => articleDelete({ article_id: '123' })]) {
    await assert.rejects(action(), error => error.code === 'NOT_LOGGED_IN');
  }
  assert.equal(closed, 7);
});

test('uncertain schedules record scheduled_for and share the posting rate limit', async t => {
  const originalHistory = config.historyFile;
  config.historyFile = join(home, 'uncertain-schedule.jsonl');
  t.after(() => { config.historyFile = originalHistory; });
  const at = new Date(Date.now() + 86400000).toISOString();
  const opened = t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => true,
    newPage: async () => ({ navigate: async () => { throw new XPosterError('UNCERTAIN', '模拟排期不确定。'); }, close: async () => {} }),
    close: async () => {},
  }));
  await assert.rejects(schedule({ text: 'hello', scheduled_at: at }), error => error.code === 'UNCERTAIN');
  const history = await readHistory(config.historyFile);
  assert.equal(history[0].uncertain, true);
  assert.equal(Date.parse(history[0].scheduled_for), Math.ceil(Date.parse(at) / 60000) * 60000);
  for (const action of [() => post({ text: 'again' }), () => schedule({ text: 'again', scheduled_at: at })]) {
    await assert.rejects(action(), error => error.code === 'RATE_LIMITED');
  }
  assert.equal(opened.mock.callCount(), 1);
});


function scheduledPage(t, { failHistory = false } = {}) {
  const listeners = new Map();
  let dialog = false;
  let selected = [];
  let pageClosed = false;
  const range = (first, last) => ['', ...Array.from({ length: last - first + 1 }, (_, i) => String(first + i))];
  const values = [range(1, 12), range(1, 31), ['', ...Array.from({ length: 3 }, (_, i) => String(new Date().getFullYear() + i))], range(0, 23), range(0, 59)];
  const page = {
    navigate: async () => {},
    waitFor: async () => true,
    call: async (fn, ...args) => {
      if (args.length === 3 && typeof args[1] === 'number') { selected[args[1]] = args[2]; return true; }
      if (args.length === 1 && args[0] === '[role=dialog]') {
        return values.map((options, i) => ({ value: selected[i] ?? '', options: options.map(value => ({ value, text: value })) }));
      }
      if (args.length === 2 && typeof args[1] === 'object') return { button: 'enabled', hasAttachments: true, uploading: false };
      if (args[0] === '[data-testid=AppTabBar_Profile_Link]') return 'alice';
      return null;
    },
    setFiles: async () => {},
    screenshot: async () => {
      if (failHistory) config.historyFile = home;
      return Buffer.from('mock PNG');
    },
    send: async method => method === 'Network.getResponseBody'
      ? { body: '{"data":{"create":{"scheduled_tweet_id":"123456"}}}' } : {},
    on: (method, listener) => { listeners.set(method, listener); return () => listeners.delete(method); },
    click: async selector => {
      if (selector.endsWith('[data-testid=scheduleOption]')) { dialog = true; return; }
      if (selector === '[data-testid=scheduledConfirmationPrimaryAction]') { assert.equal(dialog, true); dialog = false; return; }
      listeners.get('Network.responseReceived')({ requestId: 'r', response: { url: 'https://x.com/i/api/graphql/hash/CreateScheduledTweet' } });
      listeners.get('Network.loadingFinished')({ requestId: 'r' });
    },
    close: async () => { pageClosed = true; },
  };
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => true, newPage: async () => page, close: async () => {} }));
  return { listeners, closed: () => pageClosed };
}

test('scheduled preview reports exact minute and confirmation, success persists id and scheduled_for', async t => {
  const originalHistory = config.historyFile;
  config.historyFile = join(home, 'confirmed-schedule.jsonl');
  t.after(() => { config.historyFile = originalHistory; });
  const mocked = scheduledPage(t);
  const image = join(home, 'schedule.png');
  await writeFile(image, 'image');
  const at = new Date(Date.now() + 86400000).toISOString();
  const previewResult = (await preview({ images: [image], scheduled_at: at })).data;
  assert.equal(previewResult.posted, false);
  assert.match(previewResult.scheduled_at, /[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(previewResult.scheduled_at), Math.ceil(Date.parse(at) / 60000) * 60000);
  assert.ok(previewResult.scheduled_at_local.length > 10);
  assert.match(previewResult.next_step, /确认.*相同.*scheduled_at.*x_schedule/);
  assert.deepEqual(await readHistory(config.historyFile), []);
  const result = (await schedule({ images: [image], scheduled_at: at })).data;
  assert.deepEqual(result, {
    ok: true, scheduled: true, id: '123456', scheduled_at: previewResult.scheduled_at,
    scheduled_at_local: previewResult.scheduled_at_local, manage_url: 'https://x.com/compose/post/unsent/scheduled',
  });
  const history = await readHistory(config.historyFile);
  assert.equal(history[0].id, result.id);
  assert.equal(history[0].scheduled_for, result.scheduled_at);
  assert.equal(history[0].images, 1);
  assert.equal(mocked.closed(), true);
  assert.equal(mocked.listeners.size, 0);
});

test('confirmed schedule with a history failure remains UNCERTAIN and points to the list', async t => {
  const originalHistory = config.historyFile;
  config.historyFile = join(home, 'failed-confirmed-schedule.jsonl');
  t.after(() => { config.historyFile = originalHistory; });
  t.mock.method(console, 'error', () => {});
  scheduledPage(t, { failHistory: true });
  const image = join(home, 'schedule-failure.png');
  await writeFile(image, 'image');
  await assert.rejects(schedule({ images: [image], scheduled_at: new Date(Date.now() + 86400000).toISOString() }), error => {
    assert.equal(error.code, 'UNCERTAIN');
    assert.match(error.message, /unsent\/scheduled/);
    assert.match(error.hint, /不要自动重试.*预排期列表/);
    return true;
  });
});

test('scheduled list tool returns records and count without altering posting history', async t => {
  const originalHistory = config.historyFile;
  config.historyFile = join(home, 'listed-schedule.jsonl');
  t.after(() => { config.historyFile = originalHistory; });
  const events = new Map();
  let closed = false;
  t.mock.method(Browser, 'open', async () => ({
    isLoggedIn: async () => true,
    newPage: async () => ({
      send: async method => method === 'Network.getResponseBody' ? { body: '{"data":{"scheduled":[{"id":"12","execute_at":1792112400,"text":"hi"}]}}' } : {},
      on: (method, listener) => { events.set(method, listener); return () => events.delete(method); },
      navigate: async () => {
        events.get('Network.responseReceived')({ requestId: 'r', response: { url: 'https://x.com/i/api/graphql/hash/FetchScheduledTweets' } });
        events.get('Network.loadingFinished')({ requestId: 'r' });
      },
      close: async () => {},
    }),
    close: async () => { closed = true; },
  }));
  const result = (await listScheduled()).data;
  assert.equal(result.count, 1);
  assert.equal(result.scheduled[0].id, '12');
  assert.equal(closed, true);
  assert.equal(events.size, 0);
  assert.deepEqual(await readHistory(config.historyFile), []);
});
