import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, symlink, unlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Browser, CDPConnection, Page, chromeArgs, openPlainWindow, profileInUse } from '../server/chrome.mjs';

function fakeSpawn(t, implementation) {
  const mocked = t.mock.method(childProcess, 'spawn', implementation);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return mocked;
}

test('ordinary and CDP Chrome share profile flags but only CDP enables debugging', () => {
  const profileDir = join(tmpdir(), 'profile');
  const plain = chromeArgs({ profileDir, debugging: false, headless: true, url: 'https://x.com/i/flow/login' });
  assert.ok(plain.includes(`--user-data-dir=${profileDir}`));
  assert.ok(plain.includes('--window-size=1280,900'));
  assert.equal(plain.some(arg => arg.startsWith('--remote-debugging')), false);
  assert.equal(plain.includes('--headless=new'), false);
  assert.equal(plain.at(-1), 'https://x.com/i/flow/login');
  if (process.platform === 'darwin') assert.ok(plain.includes('--use-mock-keychain'));
  if (process.platform === 'linux') assert.ok(plain.includes('--password-store=basic'));
  for (const headless of [false, true]) {
    const debugging = chromeArgs({ profileDir, debugging: true, headless });
    assert.ok(debugging.includes('--remote-debugging-port=0'));
    assert.equal(debugging.includes('--headless=new'), headless);
    assert.equal(debugging.at(-1), 'about:blank');
    assert.deepEqual(debugging.filter(arg => !arg.startsWith('--remote-debugging') && arg !== '--headless=new').slice(0, -1), plain.slice(0, -1));
    assert.equal(debugging.some(arg => /enable-automation|AutomationControlled/.test(arg)), false);
  }
});

test('plain window spawn is detached, stays referenced and resolves only on process exit', async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'x-poster-plain-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 123;
  child.unref = () => assert.fail('User window must stay referenced');
  child.kill = () => assert.fail('User window must not be killed');
  fakeSpawn(t, (executablePath, args, options) => {
    assert.equal(executablePath, '/fake/chrome');
    assert.deepEqual(options, { stdio: 'ignore', detached: true });
    assert.equal(args.some(arg => arg.startsWith('--remote-debugging')), false);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const window = await openPlainWindow({ profileDir, executablePath: '/fake/chrome', url: 'https://x.com/home' });
  assert.equal(window.pid, 123);
  let finished = false;
  window.exited.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  child.emit('exit', 0);
  await window.exited;
  assert.equal(finished, true);
});

test('plain window spawn errors become BROWSER_NOT_FOUND', async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'x-poster-plain-error-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  fakeSpawn(t, () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('spawn failed')));
    return child;
  });
  await assert.rejects(openPlainWindow({ profileDir, executablePath: '/fake/chrome' }), error => error.code === 'BROWSER_NOT_FOUND');
});

test('profile locks distinguish live, dead, malformed and missing pids', { skip: process.platform === 'win32' }, async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'x-poster-lock-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  const lock = join(profileDir, 'SingletonLock');
  assert.equal(await profileInUse(profileDir), false);
  await symlink(`${hostname()}-${process.pid}`, lock);
  assert.equal(await profileInUse(profileDir), true);
  await unlink(lock);
  const deadPid = 999999;
  assert.throws(() => process.kill(deadPid, 0), error => error.code === 'ESRCH');
  await symlink(`${hostname()}-${deadPid}`, lock);
  assert.equal(await profileInUse(profileDir), false);
  await unlink(lock);
  for (const target of ['host-not-a-pid', 'host-0', 'host-', 'host-99999999999999999']) {
    await symlink(target, lock);
    assert.equal(await profileInUse(profileDir), false);
    await unlink(lock);
  }
});

test('EPERM still means the profile process is alive', { skip: process.platform === 'win32' }, async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'x-poster-lock-permission-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  await symlink('host-123', join(profileDir, 'SingletonLock'));
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  assert.equal(await profileInUse(profileDir), true);
});

test('Browser.open refuses a locked profile without spawning or contacting the network', { skip: process.platform === 'win32' }, async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'x-poster-busy-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  await symlink(`${hostname()}-${process.pid}`, join(profileDir, 'SingletonLock'));
  const spawned = fakeSpawn(t, () => assert.fail('Locked profile must never spawn'));
  const connect = t.mock.method(CDPConnection, 'connect', async () => { throw new Error('stale endpoint'); });
  await assert.rejects(openPlainWindow({ profileDir, executablePath: '/must-not-spawn/chrome', url: 'https://x.com/home' }), error => error.code === 'BROWSER_BUSY');
  for (const stale of [false, true]) {
    if (stale) await writeFile(join(profileDir, 'DevToolsActivePort'), '12345\n/devtools/browser/stale-id\n');
    await assert.rejects(Browser.open({ profileDir, executablePath: '/must-not-spawn/chrome', headless: true }), error => {
      assert.equal(error.code, 'BROWSER_BUSY');
      assert.match(error.message, /专用 Chrome 仍在运行/);
      assert.match(error.hint, /Cmd\+Q/);
      return true;
    });
  }
  assert.equal(spawned.mock.callCount(), 0);
  assert.equal(connect.mock.callCount(), 1);
});

class Socket extends EventTarget {
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.dispatchEvent(new Event('close')); }
}

test('CDP correlates out of order responses and scopes events', async () => {
  const socket = new Socket();
  const cdp = new CDPConnection(socket);
  const a = cdp.send('A');
  const b = cdp.send('B', { x: 1 }, 'session');
  assert.deepEqual(socket.sent.map(r => r.id), [1, 2]);
  assert.equal(socket.sent[1].sessionId, 'session');
  socket.receive({ id: 2, result: { b: true } });
  socket.receive({ id: 1, result: { a: true } });
  assert.deepEqual(await a, { a: true });
  assert.deepEqual(await b, { b: true });
  const page = new Page(cdp, 'target', 'session');
  const events = [];
  const unsubscribe = page.on('E', params => events.push(params));
  socket.receive({ method: 'E', params: 1, sessionId: 'other' });
  socket.receive({ method: 'E', params: 2, sessionId: 'session' });
  unsubscribe();
  socket.receive({ method: 'E', params: 3, sessionId: 'session' });
  assert.deepEqual(events, [2]);
  cdp.close();
});

test('CDP rejects response errors, individual timeouts and all work on disconnect', async () => {
  const socket = new Socket();
  const cdp = new CDPConnection(socket);
  const request = cdp.send('Bad');
  socket.receive({ id: 1, error: { message: 'denied' } });
  await assert.rejects(request, /Bad: denied/);
  await assert.rejects(cdp.send('Slow', {}, undefined, 5), /超时/);
  const pending = cdp.send('Pending');
  const pending2 = cdp.send('Pending2');
  socket.close();
  await assert.rejects(pending, /与 Chrome 的连接已断开/);
  await assert.rejects(pending2, /与 Chrome 的连接已断开/);
  assert.equal(cdp.closed, true);
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send('AfterClose'), /已断开/);
});

test('login cookies must belong to X and be unexpired', async () => {
  let cookies = [];
  const browser = new Browser({ send: async () => ({ cookies }) });
  for (const domain of ['x.com', '.x.com', '.twitter.com']) {
    cookies = [{ name: 'auth_token', domain, expires: -1 }];
    assert.equal(await browser.isLoggedIn(), true);
  }
  for (const cookie of [
    { name: 'auth_token', domain: 'evilx.com', expires: -1 },
    { name: 'auth_token', domain: 'x.com.evil.test', expires: -1 },
    { name: 'auth_token', domain: 'x.com', expires: Date.now() / 1000 - 1 },
    { name: 'other', domain: 'x.com', expires: -1 },
  ]) {
    cookies = [cookie];
    assert.equal(await browser.isLoggedIn(), false);
  }
});

test('reused browser closes only created targets', async () => {
  const calls = [];
  const cdp = {
    closed: false,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'existing' }] };
      if (method === 'Target.createTarget') return { targetId: 'ours' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      return {};
    },
    close() { this.closed = true; },
  };
  const browser = new Browser(cdp);
  const page = await browser.newPage();
  assert.equal(page.targetId, 'ours');
  await browser.close();
  assert.equal(calls.some(([method]) => method === 'Browser.close'), false);
  assert.deepEqual(calls.at(-1), ['Target.closeTarget', { targetId: 'ours' }]);
  assert.equal(cdp.closed, true);
});

test('Page waits across navigation errors and translates navigation failure', async () => {
  const page = new Page({ send: async () => ({ errorText: 'net::ERR_FAILED' }) }, 't', 's');
  await assert.rejects(page.navigate('https://x.com'), error => error.code === 'NETWORK_ERROR');
  let polls = 0;
  page.call = async () => {
    if (polls++ === 0) throw new Error('Execution context destroyed during navigation');
    return 'ready';
  };
  assert.equal(await page.waitFor(() => true, [], { interval: 1, timeout: 50 }), 'ready');
  page.call = async () => false;
  assert.equal(await page.waitFor(() => true, [], { timeout: 2, interval: 1 }), null);
});

test('article Escape and DocumentEnd send trusted key events with commands only on keyDown', async () => {
  const calls = [];
  const page = new Page({ send: async (method, params) => calls.push([method, params]) }, 'target', 'session');
  await page.press('Escape');
  await page.press('DocumentEnd');
  assert.deepEqual(calls.map(call => call[1].type), ['keyDown', 'keyUp', 'keyDown', 'keyUp']);
  assert.equal(calls[0][1].key, 'Escape');
  assert.equal(calls[0][1].windowsVirtualKeyCode, 27);
  assert.deepEqual(calls[2][1].commands, ['moveToEndOfDocument']);
  assert.equal(Object.hasOwn(calls[3][1], 'commands'), false);
});
