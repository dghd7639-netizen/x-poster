import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Browser, findChrome, openPlainWindow } from './chrome.mjs';
import { config, ensureHome, loadState, saveState } from './config.mjs';
import { XPosterError } from './errors.mjs';
import { appendHistory, checkRateLimit, readHistory } from './limits.mjs';
import { MAX_WEIGHTED_LENGTH, validatePostInput } from './validate.mjs';
import { compose, URLS } from './x.mjs';

let queue = Promise.resolve();
export function exclusive(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

export function openBrowser(headless) {
  return Browser.open({ profileDir: config.profileDir, executablePath: config.chromePath ?? findChrome(), headless });
}

let userWindowPromise = null;

async function checkLogin() {
  const browser = await openBrowser(true);
  try { return await browser.isLoggedIn(); }
  finally { await browser.close(); }
}

async function watchUserWindow(exited) {
  try {
    await exited;
    return await exclusive(async () => ({ logged_in: await checkLogin(), reason: 'window_closed' }));
  } catch {
    return { logged_in: false, reason: 'check_failed' };
  } finally {
    userWindowPromise = null;
  }
}

export function openUserWindow() {
  if (userWindowPromise) return userWindowPromise;
  userWindowPromise = exclusive(async () => {
    await ensureHome();
    const mode = await checkLogin() ? 'attention' : 'login';
    const executablePath = config.chromePath ?? findChrome();
    if (!executablePath) {
      throw new XPosterError('BROWSER_NOT_FOUND', '没有找到 Chrome 浏览器。', {
        hint: '请安装 Chrome，或设置 X_POSTER_CHROME_PATH。',
      });
    }
    const { exited } = await openPlainWindow({
      profileDir: config.profileDir, executablePath, url: mode === 'login' ? URLS.login : URLS.home,
    });
    return { mode, done: watchUserWindow(exited) };
  }).catch(error => {
    userWindowPromise = null;
    throw error;
  });
  return userWindowPromise;
}

async function waitForOutcome(done, milliseconds) {
  let timer;
  try {
    return await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

function limits(history) {
  return checkRateLimit(history, { minIntervalSec: config.minIntervalSec, dailyLimit: config.dailyLimit });
}

function requireUserWindowClosed() {
  if (userWindowPromise) {
    throw new XPosterError('LOGIN_IN_PROGRESS', '登录窗口仍在运行。', {
      hint: '用户完成登录后，请让其在该 Chrome 中按 Cmd+Q 完全退出（Windows/Linux 关闭它的所有窗口），再调用 x_status。',
    });
  }
}

export function status() {
  return exclusive(async () => {
    requireUserWindowClosed();
    const history = await readHistory(config.historyFile);
    const state = await loadState();
    const browser = await openBrowser(true);
    let loggedIn;
    try {
      loggedIn = await browser.isLoggedIn();
    } finally { await browser.close(); }
    const rate = limits(history);
    return { data: {
      logged_in: loggedIn,
      ...(loggedIn ? { username: state.username ?? null } : {}),
      login_window_open: userWindowPromise !== null,
      posts_last_24h: rate.postsLast24h,
      last_post_at: rate.lastPostAt,
      next_post_allowed_in_sec: rate.retryAfterSec,
      limits: { min_interval_sec: config.minIntervalSec, daily_limit: config.dailyLimit },
      headless: config.headless,
      data_dir: config.home,
    } };
  });
}

export async function login(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new XPosterError('INVALID_INPUT', '登录参数必须是对象。');
  }
  const { wait_seconds = 0 } = args;
  if (!Number.isInteger(wait_seconds) || wait_seconds < 0 || wait_seconds > 300) {
    throw new XPosterError('INVALID_INPUT', 'wait_seconds 必须是 0 到 300 之间的整数。');
  }
  const { mode, done } = await openUserWindow();
  const outcome = wait_seconds > 0 ? await waitForOutcome(done, wait_seconds * 1000) : null;
  if (outcome) {
    return { data: {
      logged_in: outcome.logged_in,
      status: outcome.logged_in ? 'logged_in' : 'window_closed',
      message: outcome.logged_in ? '登录成功，可以继续调用 x_status 或 x_preview。'
        : '窗口已关闭，但没有检测到 X 登录状态。需要时请重新调用 x_login。',
    } };
  }
  return { data: mode === 'login' ? {
    logged_in: false, status: 'waiting_for_user',
    message: '已打开一个普通的 Chrome 窗口（不受自动化控制，可使用 Google/Apple 账号登录）。请让用户在窗口里自己登录 X（包括两步验证），完成后在该窗口按 Cmd+Q 完全退出 Chrome（Windows/Linux 关闭它的所有窗口）并告诉你，然后调用 x_status 确认。不要索要或代填密码。',
  } : {
    logged_in: true, status: 'window_open',
    message: '当前已登录。已在普通 Chrome 窗口打开 X 主页，供用户处理验证提示或检查账号；完成后请让用户按 Cmd+Q 完全退出该 Chrome（Windows/Linux 关闭它的所有窗口）。',
  } };
}

async function preparePreviews() {
  await ensureHome();
  await mkdir(config.previewsDir, { recursive: true, mode: 0o700 });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(config.previewsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
    const file = join(config.previewsDir, entry.name);
    try {
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function runCompose(args, submit) {
  const input = await validatePostInput(args);
  return exclusive(async () => {
    requireUserWindowClosed();
    if (submit) {
      const rate = limits(await readHistory(config.historyFile));
      if (!rate.allowed) {
        throw new XPosterError('RATE_LIMITED', `请等待 ${rate.retryAfterSec} 秒后再发布。`, {
          retry_after_sec: rate.retryAfterSec, posts_last_24h: rate.postsLast24h,
          hint: '请告诉用户需要等待多久，不要循环重试。限制由 X_POSTER_MIN_INTERVAL_SEC / X_POSTER_DAILY_LIMIT 设置。',
        });
      }
    }
    await preparePreviews();
    const browser = await openBrowser(config.headless);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = join(config.previewsDir, `${stamp}-${submit ? 'post' : 'preview'}.png`);
    let result;
    try {
      if (!await browser.isLoggedIn()) {
        throw new XPosterError('NOT_LOGGED_IN', '尚未登录 X。', {
          hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。',
        });
      }
      try {
        result = await compose(browser, { ...input, submit, screenshotPath });
      } catch (error) {
        if (submit && error instanceof XPosterError && error.code === 'UNCERTAIN') {
          await appendHistory(config.historyFile, {
            ts: new Date().toISOString(), uncertain: true, text: input.text.slice(0, 80), images: input.images.length,
          }).catch(failure => console.error('保存不确定发布记录失败：', failure));
        }
        throw error;
      }
      if (submit) {
        const postedAt = new Date().toISOString();
        const url = `https://x.com/${result.username ?? 'i'}/status/${result.id}`;
        try {
          await appendHistory(config.historyFile, {
            ts: postedAt, id: result.id, url, text: input.text.slice(0, 80), images: input.images.length,
          });
        } catch (error) {
          console.error('保存已发布帖子记录失败：', error);
          throw new XPosterError('UNCERTAIN', `X 已返回发布成功，但本地历史记录保存失败。帖子链接：${url}`, {
            hint: '不要自动重试。请用户检查帖子和数据目录权限；本次发布未能计入本地限制。',
          });
        }
        if (result.username) {
          await saveState({ username: result.username }).catch(error => console.error('保存用户名失败：', error));
        }
        return { data: { ok: true, posted: true, id: result.id, url, username: result.username, posted_at: postedAt } };
      }
      if (result.username) await saveState({ username: result.username });
      return { data: {
        ok: true, posted: false, preview_image: screenshotPath,
        text: input.text, images: input.images, weighted_length: input.weightedLength,
        ...(input.weightedLength > MAX_WEIGHTED_LENGTH ? {
          warning: '加权长度超过 280；非 Premium 账号可能需要缩短文字。中日韩文字和 emoji 计 2，链接计 23。',
        } : {}),
        next_step: '这只是预览，尚未发布。请把截图和最终文字给用户确认；用户同意后，用完全相同的 text 和 images 调用 x_post。',
      }, image: result.screenshot };
    } finally {
      await browser.close().catch(error => console.error('关闭浏览器失败：', error));
    }
  });
}

export function preview(args) { return runCompose(args, false); }
export function post(args) { return runCompose(args, true); }

const postSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Post text. CJK characters and emoji count as 2, URLs as 23; non-Premium accounts have a weighted limit of 280.' },
    images: { type: 'array', items: { type: 'string' }, maxItems: 4,
      description: 'Absolute local paths to up to 4 jpg/jpeg/png/webp/gif images. Images may be at most 5 MB each; GIFs at most 15 MB.' },
  },
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: 'x_status',
    description: 'Check the dedicated X profile login state and local posting limits. Start here, then use x_login if needed, preview, show the preview to the user, and obtain confirmation before x_post.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'x_login',
    description: 'Open an ordinary Chrome window that is not automation-controlled, allowing Google/Apple sign-in. The human logs in themselves or resolves verification; never request or type passwords or bypass CAPTCHA. Afterwards the human must fully quit this Chrome (Cmd+Q on macOS; close all its windows on Windows/Linux) before other x-poster tools can use the profile. Then check x_status, preview and obtain user confirmation before posting.',
    inputSchema: { type: 'object', properties: {
      wait_seconds: { type: 'integer', minimum: 0, maximum: 300,
        description: 'Seconds to wait for the human to fully quit the ordinary login window, from 0 to 300. Default 0 returns immediately with the window open.' },
    }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'x_preview',
    description: 'Fill the X composer with text and local images, take a screenshot, and discard without posting. Show the screenshot and final text to the user and obtain explicit confirmation before calling x_post with exactly the same text and images. Login is performed by the human; never request or type passwords.',
    inputSchema: postSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'x_post',
    description: 'Publish one X post with text and up to 4 local images. First use x_preview, show its screenshot and final text to the user, and obtain explicit confirmation; use exactly the confirmed text and images. The human logs in themselves; never request or type passwords. Never retry an UNCERTAIN result: ask the user to check their profile to avoid a duplicate.',
    inputSchema: postSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const handlers = { x_status: status, x_login: login, x_preview: preview, x_post: post };
export function hasTool(name) { return Object.hasOwn(handlers, name); }

export async function callTool(name, args) {
  try {
    if (!hasTool(name)) throw new XPosterError('INVALID_INPUT', '未知工具。');
    const { data, image } = await handlers[name](args);
    const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
    if (image) content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
    return { content };
  } catch (error) {
    let reported = error;
    if (!(reported instanceof XPosterError)) {
      console.error('x-poster 内部错误：', error);
      reported = new XPosterError('INTERNAL_ERROR', '发生内部错误。', { hint: '请查看服务端错误日志。' });
    }
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, ...reported.toJSON() }, null, 2) }] };
  }
}
