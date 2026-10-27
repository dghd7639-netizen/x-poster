import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, unlink } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { XPosterError } from './errors.mjs';
import { holdsLock } from './lock.mjs';

export function findChrome() {
  let candidates;
  if (process.platform === 'darwin') {
    const browsers = [
      ['Google Chrome', 'Google Chrome'], ['Chromium', 'Chromium'],
      ['Microsoft Edge', 'Microsoft Edge'], ['Brave Browser', 'Brave Browser'],
    ];
    candidates = browsers.flatMap(([app, binary]) => ['/Applications', join(homedir(), 'Applications')]
      .map(root => join(root, `${app}.app`, 'Contents', 'MacOS', binary)));
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    candidates = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe',
      'BraveSoftware/Brave-Browser/Application/brave.exe'].flatMap(binary => roots.map(root => join(root, binary)));
  } else {
    const roots = (process.env.PATH || '').split(delimiter).filter(Boolean);
    candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
      .flatMap(binary => roots.map(root => join(root, binary)));
  }
  return candidates.find(path => existsSync(path)) ?? null;
}

export class CDPConnection {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
        else request.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) {
          try { listener({ method: message.method, params: message.params, sessionId: message.sessionId }); }
          catch (error) { console.error('CDP 事件处理失败：', error); }
        }
      }
    });
    socket.addEventListener('close', () => this.disconnect());
  }

  static connect(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
      };
      const opened = () => { cleanup(); resolve(new CDPConnection(socket)); };
      const failed = () => { cleanup(); socket.close(); reject(new Error('无法连接 Chrome。')); };
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error('连接 Chrome 超时。'));
      }, timeoutMs);
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('与 Chrome 的连接已断开'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}：Chrome 请求超时。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect() {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('与 Chrome 的连接已断开'));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  close() {
    this.disconnect();
    this.socket.close();
  }
}

const children = new Set();
process.on('exit', () => {
  for (const child of children) {
    try { child.kill(); } catch { /* Continue cleaning up other owned browsers. */ }
  }
});

export function chromeArgs({ profileDir, debugging, headless = false, url = 'about:blank' }) {
  const args = [
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--hide-crash-restore-bubble', '--window-size=1280,900',
  ];
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  if (process.platform === 'linux') args.push('--password-store=basic');
  if (debugging) {
    args.push('--remote-debugging-port=0');
    if (headless) args.push('--headless=new');
  }
  if (url != null) args.push(url);
  return args;
}

export async function openPlainWindow({ profileDir, executablePath, url }) {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  // Chrome would otherwise hand this URL to a running, possibly CDP-controlled instance.
  if (await profileInUse(profileDir)) throw profileBusy();
  const failure = () => new XPosterError('BROWSER_NOT_FOUND', '无法启动指定的 Chrome。', {
    hint: '请安装 Chrome，或设置 X_POSTER_CHROME_PATH。',
  });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executablePath, chromeArgs({ profileDir, debugging: false, url }), {
        stdio: 'ignore', detached: true,
      });
    } catch { reject(failure()); return; }
    const exited = new Promise(done => child.once('exit', () => done()));
    child.once('error', () => reject(failure()));
    child.once('spawn', () => resolve({ pid: child.pid, exited }));
  });
}

function pidAlive(pid, kill) {
  if (!pid) return false;
  try { kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function profileInUse(profileDir, { platform = process.platform, kill = process.kill } = {}) {
  if (platform === 'win32') return false;
  return pidAlive(await profilePid(profileDir), kill);
}

async function profilePid(profileDir) {
  let lock;
  try { lock = await readlink(join(profileDir, 'SingletonLock')); }
  catch { return null; }
  const suffix = lock.slice(lock.lastIndexOf('-') + 1);
  if (!lock.includes('-') || !/^\d+$/.test(suffix)) return null;
  const pid = Number(suffix);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function profileBusy() {
  return new XPosterError('BROWSER_BUSY', '专用 Chrome 仍在运行（可能是登录窗口）。', {
    hint: '如果用户已完成登录，请让用户在该 Chrome 中按 Cmd+Q 完全退出（Windows/Linux 关闭它的所有窗口），然后重试。',
  });
}

async function endpoint(profileDir) {
  try {
    const [port, path] = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535
      && /^\/devtools\/browser\/[\w-]+$/.test(path)) return `ws://127.0.0.1:${port}${path}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return null;
}

async function launchedProfilePid(profileDir, previous) {
  const pid = await profilePid(profileDir);
  return pid && (pid !== previous.pid || !previous.alive) ? pid : null;
}

export async function cleanupLaunch({ child, cdp, pid, profileDir, previous, lockPath }, runtime) {
  try {
    if (child) child.kill();
    else {
      pid ??= await launchedProfilePid(profileDir, previous);
      // Never close or kill an unproven browser, or one whose operation lock we no longer hold.
      if (pid && holdsLock(lockPath)) {
        if (cdp) await cdp.send('Browser.close', {}, undefined, 2000).catch(() => {});
        try { runtime.kill(pid, 'SIGKILL'); } catch { /* The browser may already have exited. */ }
      }
    }
  } finally { cdp?.close(); }
}

async function launch({ profileDir, executablePath, headless, foreground, lockPath }, runtime) {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const previous = { pid: await profilePid(profileDir) };
  previous.alive = pidAlive(previous.pid, runtime.kill);
  // Browser.open checks profileInUse first; recheck here before removing a live browser's endpoint.
  if (previous.alive || await profileInUse(profileDir, runtime)) throw profileBusy();
  await unlink(join(profileDir, 'DevToolsActivePort')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const appPath = executablePath.match(/^(\/.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1];
  const background = runtime.platform === 'darwin' && !headless && !foreground && Boolean(appPath);
  const args = chromeArgs({ profileDir, debugging: true, headless, ...(background ? { url: null } : {}) });
  let child = null;
  let spawnError;
  if (background) {
    try {
      await new Promise((resolve, reject) => {
        runtime.execFile('open', ['-g', '-n', '-a', appPath, '--args', ...args, '--no-startup-window'],
          { timeout: 20000 }, error => error ? reject(error) : resolve());
      });
    } catch (error) {
      throw new XPosterError(error.code === 'ENOENT' ? 'BROWSER_NOT_FOUND' : 'BROWSER_LAUNCH_FAILED',
        '无法在后台启动指定的 Chrome。', { hint: '请检查 X_POSTER_CHROME_PATH 和浏览器安装。' });
    }
  } else {
    try { child = runtime.spawn(executablePath, args, { stdio: 'ignore' }); }
    catch {
      throw new XPosterError('BROWSER_NOT_FOUND', '无法启动指定的 Chrome。', { hint: '请检查 X_POSTER_CHROME_PATH。' });
    }
    children.add(child);
    child.once('error', error => { spawnError = error; children.delete(child); });
    child.once('exit', () => children.delete(child));
  }
  let cdp;
  let pid = null;
  try {
    const deadline = runtime.now() + 20000;
    while (runtime.now() < deadline) {
      if (spawnError) {
        throw new XPosterError('BROWSER_NOT_FOUND', '无法启动指定的 Chrome。', { hint: '请检查 X_POSTER_CHROME_PATH。' });
      }
      const url = await endpoint(profileDir);
      if (url) {
        cdp = await runtime.connect(url);
        if (background) {
          try {
            const { processInfo } = await cdp.send('SystemInfo.getProcessInfo', {}, undefined, 2000);
            const id = processInfo?.find(info => info.type === 'browser')?.id;
            if (Number.isSafeInteger(id) && id > 0) pid = id;
          } catch { /* Older browsers may not expose SystemInfo. */ }
          pid ??= await launchedProfilePid(profileDir, previous);
          if (!pid) throw new XPosterError('BROWSER_LAUNCH_FAILED', '无法确定后台 Chrome 的进程。', {
            hint: '无法确认进程归属，未关闭或终止已有 Chrome。请检查专用配置目录的浏览器后再试。',
          });
        }
        return { cdp, child, pid, background };
      }
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new XPosterError('BROWSER_BUSY', `Chrome 提前退出，可能有其他 Chrome 正在使用此配置目录：${profileDir}`, {
          hint: '请关闭使用该目录的 Chrome 后再试。',
        });
      }
      await runtime.delay(100);
    }
    throw new XPosterError('BROWSER_LAUNCH_FAILED', 'Chrome 启动超时。', { hint: '请检查浏览器能否正常启动。' });
  } catch (error) {
    await cleanupLaunch({ child, cdp, pid, profileDir, previous, lockPath }, runtime);
    if (error instanceof XPosterError) throw error;
    throw new XPosterError('BROWSER_LAUNCH_FAILED', 'Chrome 启动后无法连接。', { hint: '请关闭此配置目录的 Chrome 后再试。' });
  }
}

export class Browser {
  constructor(cdp, child = null, { pid = null, background = false, runtime = {} } = {}) {
    this.cdp = cdp;
    this.child = child;
    this.pid = pid;
    this.background = background;
    this.runtime = { now: Date.now, delay, kill: (pid, signal) => process.kill(pid, signal), ...runtime };
    this.owned = child !== null || pid !== null;
    if (pid !== null) {
      this.processHandle = { kill: signal => this.runtime.kill(pid, signal) };
      children.add(this.processHandle);
    }
    this.usedInitialPage = false;
    this.targets = new Set();
    this.closePromise = null;
  }

  static async open({ profileDir, executablePath, headless, foreground, lockPath = join(dirname(profileDir), 'browser.lock') }, dependencies = {}) {
    const runtime = { platform: process.platform, spawn, execFile, connect: CDPConnection.connect,
      now: Date.now, delay, kill: (pid, signal) => process.kill(pid, signal), ...dependencies };
    const url = await endpoint(profileDir);
    if (url) {
      try { return new Browser(await runtime.connect(url, 2000), null, { runtime }); }
      catch { /* A stale port file is expected after an interrupted Chrome session. */ }
    }
    if (await profileInUse(profileDir, runtime)) {
      throw profileBusy();
    }
    if (!executablePath) {
      throw new XPosterError('BROWSER_NOT_FOUND', '没有找到 Chrome 浏览器。', {
        hint: '请安装 Chrome，或设置 X_POSTER_CHROME_PATH。',
      });
    }
    // Keep configuration lazy: Chrome helpers are also used before callers initialise their environment.
    foreground ??= (await import('./config.mjs')).config.foreground;
    const { cdp, child, pid, background } = await launch({ profileDir, executablePath, headless, foreground, lockPath }, runtime);
    return new Browser(cdp, child, { pid, background, runtime });
  }

  async isHeadless() {
    const { product = '', userAgent = '' } = await this.cdp.send('Browser.getVersion');
    return /Headless/i.test(`${product} ${userAgent}`);
  }

  async isLoggedIn() {
    const { cookies } = await this.cdp.send('Storage.getCookies');
    return cookies.some(cookie => cookie.name === 'auth_token' && /(^|\.)(x|twitter)\.com$/.test(cookie.domain)
      && (cookie.expires <= 0 || cookie.expires * 1000 > Date.now()));
  }

  async hasTarget(targetId) {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    return targetInfos.some(target => target.targetId === targetId);
  }

  async newPage() {
    let targetId;
    if (this.owned && !this.background && !this.usedInitialPage) {
      this.usedInitialPage = true;
      const deadline = Date.now() + 2000;
      do {
        const { targetInfos } = await this.cdp.send('Target.getTargets');
        targetId = targetInfos.find(target => target.type === 'page')?.targetId;
        if (targetId) break;
        await delay(100);
      } while (Date.now() < deadline);
    }
    if (!targetId) {
      const { targetInfos } = await this.cdp.send('Target.getTargets');
      const hasPage = targetInfos.some(target => target.type === 'page');
      ({ targetId } = await this.cdp.send('Target.createTarget', {
        url: 'about:blank', background: true, ...(!hasPage ? { newWindow: true } : {}),
      }));
    }
    this.targets.add(targetId);
    try {
      const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      return new Page(this.cdp, targetId, sessionId);
    } catch (error) {
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      throw error;
    }
  }

  close() {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  async shutdown() {
    try {
      if (this.owned) {
        await this.cdp.send('Browser.close', {}, undefined, 2000).catch(() => {});
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
          await new Promise(resolve => {
            const exited = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => {
              this.child.removeListener('exit', exited);
              this.child.kill('SIGKILL');
              resolve();
            }, 10000);
            this.child.once('exit', exited);
          });
        } else if (!this.child && this.pid !== null) {
          const deadline = this.runtime.now() + 10000;
          while (true) {
            try { this.runtime.kill(this.pid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') break;
            }
            if (this.runtime.now() >= deadline) {
              try { this.processHandle.kill('SIGKILL'); }
              catch (error) { if (error.code !== 'ESRCH') throw error; }
              break;
            }
            await this.runtime.delay(100);
          }
          children.delete(this.processHandle);
        }
      } else {
        for (const targetId of this.targets) {
          if (!this.cdp.closed) await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
        }
      }
    } finally {
      this.cdp.close();
    }
  }
}

async function renderingStep(action, timeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function measureFrames() {
  return new Promise(resolve => {
    let frames = 0;
    let frame;
    let done = false;
    const finish = () => {
      done = true;
      cancelAnimationFrame(frame);
      resolve({ frames, visibility: document.visibilityState });
    };
    // Finish with a timer even when the background tab never supplies a frame.
    setTimeout(finish, 500);
    const count = () => {
      if (done) return;
      frames++;
      frame = requestAnimationFrame(count);
    };
    frame = requestAnimationFrame(count);
  });
}

export class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method, params = {}, timeout) { return this.cdp.send(method, params, this.sessionId, timeout); }

  async ensureRendering() {
    const measure = async () => {
      const response = await renderingStep(() => this.send('Runtime.evaluate', {
        expression: `(${measureFrames.toString()})()`, returnByValue: true, awaitPromise: true,
      }, 1500), 1500);
      const value = response?.exceptionDetails ? null : response?.result?.value;
      return { frames: Number.isInteger(value?.frames) && value.frames >= 0 ? value.frames : null,
        visibility: ['visible', 'hidden', 'prerender'].includes(value?.visibility) ? value.visibility : null };
    };
    let sample = await measure();
    const result = { stalled: sample.frames === null || sample.frames * 2 < 5,
      initial_frames: sample.frames, remedy: null, final_frames: sample.frames, visibility: sample.visibility };
    if (!result.stalled) {
      result.frames = sample.frames;
      return (this.rendering = result);
    }
    // Three 1500 ms measurements plus two 400 ms commands and 300 ms waits: at most 5900 ms.
    for (const [remedy, method, params] of [
      ['focus_emulation', 'Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['bring_to_front', 'Page.bringToFront', {}],
    ]) {
      result.remedy = remedy;
      await renderingStep(() => this.send(method, params, 400), 400);
      await renderingStep(() => delay(300), 300);
      sample = await measure();
      result.final_frames = sample.frames;
      result.visibility = sample.visibility;
      result.stalled = sample.frames === null || sample.frames * 2 < 5;
      if (!result.stalled) break;
    }
    return (this.rendering = result);
  }

  on(method, handler) {
    return this.cdp.on(event => {
      if (event.sessionId === this.sessionId && event.method === method) handler(event.params);
    });
  }

  async navigate(url) {
    const { errorText } = await this.send('Page.navigate', { url });
    if (errorText) throw new XPosterError('NETWORK_ERROR', '无法打开 X 页面。', { hint: '请检查网络或代理设置。' });
  }

  async call(fn, ...args) {
    const response = await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '页面执行失败。');
    }
    return response.result?.value;
  }

  async waitFor(fn, args = [], { timeout = 30000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    do {
      try {
        const value = await this.call(fn, ...args);
        if (value) return value;
      } catch (error) {
        if (!/context|navigat/i.test(error.message)) throw error;
      }
      if (Date.now() >= deadline) return null;
      await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
    } while (true);
  }

  async click(selector) {
    const point = await this.call(selector => {
      const el = document.querySelector(selector);
      if (!el) return { missing: true };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      return { x, y, covered: !el.contains(document.elementFromPoint(x, y)) };
    }, selector);
    if (point.missing || point.covered) {
      throw new XPosterError('UI_CHANGED', point.missing ? '找不到页面按钮。' : '页面按钮被遮挡。', {
        selector, ...(point.covered ? { hint: '可能有其他对话框遮挡，请用户查看 Chrome 窗口。' } : {}),
      });
    }
    const { x, y } = point;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  insertText(text) { return this.send('Input.insertText', { text }); }

  async press(key) {
    const keys = {
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      DocumentEnd: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, commands: ['moveToEndOfDocument'] },
      SelectAll: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
        modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] },
    };
    if (!keys[key]) throw new XPosterError('INVALID_INPUT', '不支持此按键。');
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keys[key] });
    const { text, commands, ...release } = keys[key];
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...release });
  }

  async setFiles(selector, files) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false,
    });
    if (exceptionDetails || !result?.objectId) {
      throw new XPosterError('UI_CHANGED', '找不到图片上传控件。', { selector });
    }
    try {
      await this.send('DOM.enable');
      await this.send('DOM.setFileInputFiles', { objectId: result.objectId, files });
    } finally {
      await this.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    }
  }

  async screenshot(clip) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    return Buffer.from(data, 'base64');
  }

  bringToFront() { return this.send('Page.bringToFront'); }
  close() { return this.cdp.send('Target.closeTarget', { targetId: this.targetId }); }
}
