import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../server/config.mjs';

const previousExitListeners = new Set(process.listeners('exit'));
const { Browser, chromeArgs } = await import('../server/chrome.mjs');
const [cleanupOnExit] = process.listeners('exit').filter(listener => !previousExitListeners.has(listener));

const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function fixture(t) {
  const profileDir = await mkdtemp(join(tmpdir(), 'x-poster-background-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  let time = 0;
  let alive = true;
  const calls = [];
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, kill: signal => {
    calls.push(['child.kill', signal]);
    child.exitCode = 0;
    child.emit('exit', 0);
  } });
  const ready = () => writeFile(join(profileDir, 'DevToolsActivePort'), '12345\n/devtools/browser/fake-id\n');
  const cdp = {
    send: async (method, params, session, timeout) => {
      calls.push([method, params, session, timeout]);
      if (method === 'SystemInfo.getProcessInfo') return { processInfo: [
        { type: 'renderer', id: 456 }, { type: 'browser', id: 123 },
      ] };
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Target.createTarget') return { targetId: 'new' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Browser.close') {
        alive = false;
        child.exitCode = 0;
        child.emit('exit', 0);
      }
      return {};
    },
    close: () => calls.push(['cdp.close']),
  };
  const runtime = {
    platform: 'darwin',
    spawn: (file, args, options) => {
      calls.push(['spawn', file, args, options]);
      return child;
    },
    execFile: (file, args, options, callback) => {
      calls.push(['execFile', file, args, options]);
      callback(null); // open has already exited before DevToolsActivePort appears.
    },
    connect: async url => { calls.push(['connect', url]); return cdp; },
    now: () => time,
    delay: async ms => { calls.push(['delay', ms]); time += ms; await ready(); },
    kill: (pid, signal) => {
      calls.push(['kill', pid, signal, runtime.now()]);
      assert.equal(pid, 123);
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  };
  const open = (options = {}) => Browser.open({ profileDir, executablePath, foreground: false, ...options }, runtime);
  return { profileDir, child, calls, cdp, runtime, open, ready, setAlive: value => { alive = value; } };
}

test('chromeArgs can omit the startup URL', () => {
  const args = chromeArgs({ profileDir: '/profile', debugging: true, url: null });
  assert.equal(args.includes('about:blank'), false);
  assert.equal(args.includes(null), false);
  assert.ok(args.includes('--remote-debugging-port=0'));
});

test('macOS open exits successfully before Chrome is ready and keeps PID ownership', { timeout: 1000 }, async t => {
  const f = await fixture(t);
  const browser = await f.open();
  const launch = f.calls.find(call => call[0] === 'execFile');
  assert.equal(launch[1], 'open');
  assert.deepEqual(launch[2].slice(0, 5), ['-g', '-n', '-a', '/Applications/Google Chrome.app', '--args']);
  assert.ok(launch[2].includes('--no-startup-window'));
  assert.equal(launch[2].includes('about:blank'), false);
  assert.equal(f.calls.some(call => call[0] === 'spawn'), false);
  assert.equal(browser.owned, true);
  assert.equal(browser.child, null);
  assert.equal(browser.pid, 123);
  await browser.close();
});

for (const options of [
  { platform: 'darwin', foreground: true }, { platform: 'linux' }, { platform: 'win32' },
  { platform: 'darwin', headless: true }, { platform: 'darwin', executablePath: '/custom/chrome' },
]) {
  test(`direct spawn remains for ${JSON.stringify(options)}`, { timeout: 1000 }, async t => {
    const f = await fixture(t);
    f.runtime.platform = options.platform;
    const browser = await f.open(options);
    assert.equal(f.calls.some(call => call[0] === 'execFile'), false);
    const launch = f.calls.find(call => call[0] === 'spawn');
    assert.equal(launch[1], options.executablePath ?? executablePath);
    assert.ok(launch[2].includes('about:blank'));
    assert.equal(launch[2].includes('--no-startup-window'), false);
    assert.equal(browser.child, f.child);
    await browser.close();
  });
}

test('Browser.open reads config.foreground when the caller only passes headless', async t => {
  const f = await fixture(t);
  const original = config.foreground;
  config.foreground = true;
  t.after(() => { config.foreground = original; });
  const browser = await f.open({ foreground: undefined, headless: false });
  assert.ok(f.calls.some(call => call[0] === 'spawn'));
  await browser.close();
});

for (const [code, expected] of [['ENOENT', 'BROWSER_NOT_FOUND'], [1, 'BROWSER_LAUNCH_FAILED']]) {
  test(`open failure ${code} is reported without polling or killing`, async t => {
    const f = await fixture(t);
    f.runtime.execFile = (file, args, options, callback) => callback(Object.assign(new Error('private details'), { code }));
    await assert.rejects(f.open(), error => error.code === expected && !error.message.includes('private details'));
    assert.equal(f.calls.some(call => ['connect', 'kill', 'delay'].includes(call[0])), false);
  });
}

for (const response of [null, {}, { processInfo: [{ type: 'browser', id: -1 }] }]) {
  test(`PID falls back to SingletonLock when CDP is unavailable: ${JSON.stringify(response)}`, async t => {
    const f = await fixture(t);
    const send = f.cdp.send;
    f.cdp.send = async (...args) => {
      if (args[0] === 'SystemInfo.getProcessInfo') {
        if (response === null) throw new Error('unsupported');
        return response;
      }
      return send(...args);
    };
    const execFile = f.runtime.execFile;
    f.runtime.execFile = async (...args) => {
      await symlink('host-with-dashes-123', join(f.profileDir, 'SingletonLock'));
      execFile(...args);
    };
    const browser = await f.open();
    assert.equal(browser.pid, 123);
    await browser.close();
  });
}

for (const existing of [false, true]) {
  test(`newPage creates a background target, existing pages: ${existing}`, async t => {
    const f = await fixture(t);
    const browser = await f.open();
    const send = f.cdp.send;
    f.cdp.send = async (...args) => args[0] === 'Target.getTargets'
      ? { targetInfos: [{ type: 'worker' }, ...(existing ? [{ type: 'page', targetId: 'other' }] : [])] }
      : send(...args);
    f.calls.length = 0;
    await browser.newPage();
    assert.deepEqual(f.calls.find(call => call[0] === 'Target.createTarget')[1], {
      url: 'about:blank', background: true, ...(!existing ? { newWindow: true } : {}),
    });
    assert.equal(f.calls.some(call => call[0] === 'delay'), false);
    await browser.close();
  });
}

test('reused browsers create background tabs without taking ownership', async t => {
  const f = await fixture(t);
  await f.ready();
  const browser = await f.open();
  assert.equal(browser.owned, false);
  f.cdp.send = async (method, params) => {
    f.calls.push([method, params]);
    if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'existing' }] };
    if (method === 'Target.createTarget') return { targetId: 'ours' };
    return { sessionId: 'session' };
  };
  await browser.newPage();
  assert.deepEqual(f.calls.find(call => call[0] === 'Target.createTarget')[1], { url: 'about:blank', background: true });
  await browser.close();
  assert.equal(f.calls.some(call => ['kill', 'Browser.close', 'execFile', 'spawn'].includes(call[0])), false);
});

for (const exitAt of [0, 300, Infinity]) {
  test(`PID shutdown closes CDP then waits at most 10s; exits at ${exitAt}`, async t => {
    const f = await fixture(t);
    const browser = await f.open();
    const start = f.runtime.now();
    f.calls.length = 0;
    f.cdp.send = async method => { f.calls.push([method]); return {}; };
    browser.runtime.delay = async ms => {
      f.calls.push(['delay', ms]);
      elapsed += ms;
      if (elapsed >= exitAt) f.setAlive(false);
    };
    let elapsed = 0;
    browser.runtime.now = f.runtime.now = () => start + elapsed;
    if (exitAt === 0) f.setAlive(false);
    await browser.close();
    assert.equal(f.calls[0][0], 'Browser.close');
    const kills = f.calls.filter(call => call[0] === 'kill' && call[2] === 'SIGKILL');
    assert.equal(kills.length, exitAt === Infinity ? 1 : 0);
    if (kills.length) assert.equal(kills[0][3] - start, 10000);
    assert.equal(elapsed, exitAt === Infinity ? 10000 : exitAt);
    assert.equal(f.calls.at(-1)[0], 'cdp.close');
    assert.equal(await browser.close(), undefined);
  });
}

test('process-exit cleanup tracks only owned PIDs and forgets closed browsers', async t => {
  const f = await fixture(t);
  const browser = await f.open();
  assert.equal(typeof cleanupOnExit, 'function');
  cleanupOnExit();
  assert.deepEqual(f.calls.filter(call => call[0] === 'kill').map(call => call.slice(0, 3)), [['kill', 123, undefined]]);
  await browser.close();
  f.calls.length = 0;
  cleanupOnExit();
  assert.equal(f.calls.some(call => call[0] === 'kill'), false);
  const reused = await f.open();
  cleanupOnExit();
  assert.equal(f.calls.some(call => call[0] === 'kill'), false);
  await reused.close();
});

test('background launch polls DevToolsActivePort for exactly 20s without a real wait', async t => {
  const f = await fixture(t);
  let time = 0;
  f.runtime.now = () => time;
  f.runtime.delay = async ms => { time += ms; };
  await assert.rejects(f.open(), error => error.code === 'BROWSER_LAUNCH_FAILED');
  assert.equal(time, 20000);
  assert.equal(f.calls.some(call => ['connect', 'kill'].includes(call[0])), false);
});

test('background launch failure closes CDP if neither PID source is available', async t => {
  const f = await fixture(t);
  const send = f.cdp.send;
  f.cdp.send = async (...args) => {
    if (args[0] === 'SystemInfo.getProcessInfo') throw new Error('unsupported');
    return send(...args);
  };
  await assert.rejects(f.open(), error => error.code === 'BROWSER_LAUNCH_FAILED');
  assert.ok(f.calls.some(call => call[0] === 'Browser.close'));
  assert.equal(f.calls.at(-1)[0], 'cdp.close');
  assert.equal(f.calls.some(call => call[0] === 'kill'), false);
});

test('background connection failure cleans up only its newly created profile lock PID', async t => {
  const f = await fixture(t);
  const execFile = f.runtime.execFile;
  f.runtime.execFile = async (...args) => {
    await symlink('host-123', join(f.profileDir, 'SingletonLock'));
    execFile(...args);
  };
  f.runtime.connect = async () => { throw new Error('private connection details'); };
  await assert.rejects(f.open(), error => error.code === 'BROWSER_LAUNCH_FAILED' && !error.message.includes('private'));
  assert.deepEqual(f.calls.filter(call => call[0] === 'kill').map(call => call.slice(0, 3)), [['kill', 123, 'SIGKILL']]);
});

test('owned direct-spawn browser reuses its initial page and keeps child shutdown', async t => {
  const f = await fixture(t);
  const browser = await f.open({ foreground: true });
  const send = f.cdp.send;
  f.cdp.send = async (...args) => args[0] === 'Target.getTargets'
    ? { targetInfos: [{ type: 'page', targetId: 'initial' }] } : send(...args);
  f.calls.length = 0;
  assert.equal((await browser.newPage()).targetId, 'initial');
  assert.equal(f.calls.some(call => ['Target.createTarget', 'delay'].includes(call[0])), false);
  await browser.close();
  assert.equal(f.calls.some(call => call[0] === 'kill'), false);
});

test('owned child shutdown retains the 10s SIGKILL fallback', async t => {
  const f = await fixture(t);
  const browser = await f.open({ foreground: true });
  f.cdp.send = async method => { f.calls.push([method]); return {}; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = browser.close();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(9999);
  assert.equal(f.calls.some(call => call[0] === 'child.kill'), false);
  t.mock.timers.tick(1);
  await closing;
  assert.deepEqual(f.calls.find(call => call[0] === 'child.kill'), ['child.kill', 'SIGKILL']);
});
