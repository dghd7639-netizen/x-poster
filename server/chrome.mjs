import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, unlink } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { XPosterError } from './errors.mjs';

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
  for (const child of children) child.kill();
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
  args.push(url);
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

export async function profileInUse(profileDir) {
  if (process.platform === 'win32') return false;
  let lock;
  try { lock = await readlink(join(profileDir, 'SingletonLock')); }
  catch { return false; }
  const suffix = lock.slice(lock.lastIndexOf('-') + 1);
  if (!lock.includes('-') || !/^\d+$/.test(suffix)) return false;
  const pid = Number(suffix);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
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

async function launch({ profileDir, executablePath, headless }) {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await unlink(join(profileDir, 'DevToolsActivePort')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const args = chromeArgs({ profileDir, debugging: true, headless });
  let child;
  let spawnError;
  try { child = spawn(executablePath, args, { stdio: 'ignore' }); }
  catch {
    throw new XPosterError('BROWSER_NOT_FOUND', '无法启动指定的 Chrome。', { hint: '请检查 X_POSTER_CHROME_PATH。' });
  }
  children.add(child);
  child.once('error', error => { spawnError = error; children.delete(child); });
  child.once('exit', () => children.delete(child));
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new XPosterError('BROWSER_NOT_FOUND', '无法启动指定的 Chrome。', { hint: '请检查 X_POSTER_CHROME_PATH。' });
      }
      const url = await endpoint(profileDir);
      if (url) return { cdp: await CDPConnection.connect(url), child };
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new XPosterError('BROWSER_BUSY', `Chrome 提前退出，可能有其他 Chrome 正在使用此配置目录：${profileDir}`, {
          hint: '请关闭使用该目录的 Chrome 后再试。',
        });
      }
      await delay(100);
    }
    throw new XPosterError('BROWSER_LAUNCH_FAILED', 'Chrome 启动超时。', { hint: '请检查浏览器能否正常启动。' });
  } catch (error) {
    child.kill();
    if (error instanceof XPosterError) throw error;
    throw new XPosterError('BROWSER_LAUNCH_FAILED', 'Chrome 启动后无法连接。', { hint: '请关闭此配置目录的 Chrome 后再试。' });
  }
}

export class Browser {
  constructor(cdp, child = null) {
    this.cdp = cdp;
    this.child = child;
    this.owned = child !== null;
    this.usedInitialPage = false;
    this.targets = new Set();
    this.closePromise = null;
  }

  static async open({ profileDir, executablePath, headless }) {
    const url = await endpoint(profileDir);
    if (url) {
      try { return new Browser(await CDPConnection.connect(url, 2000)); }
      catch { /* A stale port file is expected after an interrupted Chrome session. */ }
    }
    if (await profileInUse(profileDir)) {
      throw profileBusy();
    }
    if (!executablePath) {
      throw new XPosterError('BROWSER_NOT_FOUND', '没有找到 Chrome 浏览器。', {
        hint: '请安装 Chrome，或设置 X_POSTER_CHROME_PATH。',
      });
    }
    const { cdp, child } = await launch({ profileDir, executablePath, headless });
    return new Browser(cdp, child);
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
    if (this.owned && !this.usedInitialPage) {
      this.usedInitialPage = true;
      const deadline = Date.now() + 2000;
      do {
        const { targetInfos } = await this.cdp.send('Target.getTargets');
        targetId = targetInfos.find(target => target.type === 'page')?.targetId;
        if (targetId) break;
        await delay(100);
      } while (Date.now() < deadline);
    }
    if (!targetId) ({ targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' }));
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
        if (this.child.exitCode === null && this.child.signalCode === null) {
          await new Promise(resolve => {
            const exited = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => {
              this.child.removeListener('exit', exited);
              this.child.kill('SIGKILL');
              resolve();
            }, 10000);
            this.child.once('exit', exited);
          });
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

export class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method, params = {}) { return this.cdp.send(method, params, this.sessionId); }

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
