import { mkdir, readdir, stat, unlink, open } from 'node:fs/promises';
import { acquireLock } from './lock.mjs';
import { randomUUID } from 'node:crypto';
import { join, dirname, isAbsolute, extname } from 'node:path';
import { Browser, findChrome, openPlainWindow } from './chrome.mjs';
import { config, ensureHome, loadState, saveState, expandHome } from './config.mjs';
import { XPosterError } from './errors.mjs';
import { appendHistory, checkRateLimit, readHistory } from './limits.mjs';
import { MAX_WEIGHTED_LENGTH, validatePostInput, parseScheduledAt, validateThreadInput } from './validate.mjs';
import { compose, listScheduled as readScheduled, cancelScheduled as deleteScheduled, URLS } from './x.mjs';
import { composeThread } from './thread.mjs';
import { parseArticleMarkdown, MAX_MARKDOWN_BYTES } from './markdown.mjs';
import { createArticleDraft, setArticleCover, publishArticle, deleteArticleDraft } from './article.mjs';

let queue = Promise.resolve();
let queued = 0;
let browserWaitOptions = {};

// The CLI has one caller and a human waiting for the result.
export function setBrowserWaitOptions(options) { browserWaitOptions = options; }

export function exclusive(fn, { maxWaitMs = browserWaitOptions.maxWaitMs ?? config.busyWaitSec * 1000,
  tool = 'browser', onStart, onWait = browserWaitOptions.onWait } = {}) {
  const deadline = Date.now() + maxWaitMs;
  const controller = new AbortController();
  let started = false;
  let notified = false;
  const waiting = () => { if (!notified) { notified = true; onWait?.(); } };
  let resolve;
  let reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const expire = () => {
    if (started || controller.signal.aborted) return;
    const error = new XPosterError('BUSY', 'x-poster 正在执行另一个浏览器任务，本次操作未执行。', {
      retry_after_sec: 30,
      hint: '本次操作没有执行，可以稍后安全重试；如果有文章或串文任务在进行，请先用 x_job_status 等它完成。',
    });
    controller.abort(error);
    reject(error);
  };
  const timer = setTimeout(expire, maxWaitMs);
  if (queued++ > 0) waiting();
  const slot = queue.then(async () => {
    let release;
    try {
      if (controller.signal.aborted) return;
      release = await acquireLock(join(config.home, 'browser.lock'), { tool, signal: controller.signal, onWait: waiting });
      // Check the deadline as well as the timer, which may be delayed by a busy event loop.
      if (Date.now() >= deadline) expire();
      if (controller.signal.aborted) return;
      started = true;
      clearTimeout(timer);
      onStart?.();
      return await fn();
    } finally {
      clearTimeout(timer);
      try { await release?.(); }
      finally { queued--; }
    }
  });
  // A cancelled slot remains in the chain until its predecessor finishes, then skips its work.
  queue = slot.catch(() => {});
  void slot.then(resolve, reject);
  return result;
}

export function pendingWork() { return queue; }

export async function waitForShutdown(work = pendingWork()) {
  await waitForOutcome(work, config.shutdownGraceSec * 1000);
}

export function openBrowser(headless) {
  return Browser.open({ profileDir: config.profileDir, executablePath: config.chromePath ?? findChrome(), headless, lockPath: join(config.home, 'browser.lock') });
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
    return await exclusive(async () => ({ logged_in: await checkLogin(), reason: 'window_closed' }), { maxWaitMs: browserWaitOptions.maxWaitMs ?? 15 * 60 * 1000, tool: 'login_check' });
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
  }, { tool: 'x_login' }).catch(error => {
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

function limits(history, count = 1) {
  return checkRateLimit(history, { minIntervalSec: config.minIntervalSec, dailyLimit: config.dailyLimit, count });
}

async function requirePostingCapacity(count = 1) {
  const rate = limits(await readHistory(config.historyFile), count);
  if (rate.allowed) return;
  const remaining = config.dailyLimit > 0 ? Math.max(0, config.dailyLimit - rate.postsLast24h) : null;
  const tooLarge = config.dailyLimit > 0 && count > config.dailyLimit;
  throw new XPosterError('RATE_LIMITED', `本次需要 ${count} 条额度，24 小时剩余可发布 ${remaining ?? '不限'} 条；${tooLarge
    ? '本次条数超过每日上限，请减少条数。' : `请等待 ${rate.retryAfterSec} 秒并核对额度后再发布。`}`, {
    retry_after_sec: rate.retryAfterSec, posts_last_24h: rate.postsLast24h,
    posts_remaining: remaining, requested_count: count,
    hint: '请告诉用户剩余额度及等待时间，不要循环重试或擅自修改限制。',
  });
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
  }, { tool: 'x_status' });
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

function scheduledTime(date) {
  const pad = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  return {
    scheduled_at: `${local}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
    scheduled_at_local: `${date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'long' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
  };
}

async function runCompose(args, mode) {
  let scheduled = mode === 'schedule' || args != null && Object.hasOwn(args, 'scheduled_at')
    ? parseScheduledAt(args?.scheduled_at) : null;
  // X's UI only accepts minutes; round up and report the exact time that will be selected.
  if (scheduled) scheduled = parseScheduledAt(new Date(Math.ceil(scheduled.date.getTime() / 60000) * 60000).toISOString());
  if (mode === 'post' && scheduled) throw new XPosterError('INVALID_INPUT', '带 scheduled_at 的帖子请使用 x_schedule。');
  const input = await validatePostInput(args);
  const submit = mode !== 'preview';
  const time = scheduled ? scheduledTime(scheduled.date) : {};
  const scheduledHistory = scheduled ? { scheduled_for: time.scheduled_at } : {};
  return exclusive(async () => {
    requireUserWindowClosed();
    if (scheduled) parseScheduledAt(scheduled.date.toISOString());
    if (submit) await requirePostingCapacity();
    await preparePreviews();
    const browser = await openBrowser(config.headless);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = join(config.previewsDir, `${stamp}-${mode}.png`);
    let result;
    try {
      if (!await browser.isLoggedIn()) {
        throw new XPosterError('NOT_LOGGED_IN', '尚未登录 X。', {
          hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。',
        });
      }
      try {
        result = await compose(browser, { ...input, mode, scheduledAt: scheduled?.components, screenshotPath });
      } catch (error) {
        if (submit && error instanceof XPosterError && error.code === 'UNCERTAIN') {
          await appendHistory(config.historyFile, {
            ts: new Date().toISOString(), uncertain: true, ...scheduledHistory, text: input.text.slice(0, 80), images: input.images.length,
          }).catch(failure => console.error('保存不确定发布记录失败：', failure));
        }
        throw error;
      }
      if (submit) {
        const postedAt = new Date().toISOString();
        const url = mode === 'schedule' ? URLS.scheduled : `https://x.com/${result.username ?? 'i'}/status/${result.id}`;
        try {
          await appendHistory(config.historyFile, {
            ts: postedAt, id: result.id, url, ...scheduledHistory, text: input.text.slice(0, 80), images: input.images.length,
          });
        } catch (error) {
          console.error('保存已发布帖子记录失败：', error);
          throw new XPosterError('UNCERTAIN', `X 已返回${mode === 'schedule' ? '预排期' : '发布'}成功，但本地历史记录保存失败。检查链接：${url}`, {
            hint: `不要自动重试。请用户检查${mode === 'schedule' ? '预排期列表' : '帖子'}和数据目录权限；本次操作未能计入本地限制。`,
          });
        }
        if (result.username) {
          await saveState({ username: result.username }).catch(error => console.error('保存用户名失败：', error));
        }
        if (mode === 'schedule') return { data: { ok: true, scheduled: true, id: result.id, ...time, manage_url: URLS.scheduled } };
        return { data: { ok: true, posted: true, id: result.id, url, username: result.username, posted_at: postedAt } };
      }
      if (result.username) await saveState({ username: result.username });
      return { data: {
        ok: true, posted: false, preview_image: screenshotPath,
        text: input.text, images: input.images, weighted_length: input.weightedLength, ...time,
        ...(input.weightedLength > MAX_WEIGHTED_LENGTH ? {
          warning: '加权长度超过 280；非 Premium 账号可能需要缩短文字。中日韩文字和 emoji 计 2，链接计 23。',
        } : {}),
        next_step: scheduled ? '这只是预览，尚未创建预排期。请把截图、最终文字和准确排期时间给用户确认；用户明确同意后，用完全相同的 text、images 和 scheduled_at 调用 x_schedule。' : '这只是预览，尚未发布。请把截图和最终文字给用户确认；用户同意后，用完全相同的 text 和 images 调用 x_post。',
      }, image: result.screenshot };
    } finally {
      await browser.close().catch(error => console.error('关闭浏览器失败：', error));
    }
  }, { tool: `x_${mode}` });
}

function runThread(input, mode, waitOptions = {}) {
  const { posts, inReplyTo, scheduled } = input;
  const count = posts.length;
  const submit = mode !== 'preview';
  const time = scheduled ? scheduledTime(scheduled.date) : {};
  const historyFields = { thread: true, text: posts[0].text.slice(0, 80),
    images: posts.reduce((sum, post) => sum + post.images.length, 0),
    ...(scheduled ? { scheduled_for: time.scheduled_at } : {}),
  };
  return exclusive(async () => {
    requireUserWindowClosed();
    if (scheduled) parseScheduledAt(scheduled.date.toISOString());
    if (submit) await requirePostingCapacity(count);
    await preparePreviews();
    const state = await loadState();
    const browser = await openBrowser(config.headless);
    try {
      if (!await browser.isLoggedIn()) throw new XPosterError('NOT_LOGGED_IN', '尚未登录 X。', {
        hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。',
      });
      const screenshotPath = join(config.previewsDir, `${randomUUID()}-thread.png`);
      let result;
      try {
        result = await composeThread(browser, { posts, inReplyTo, scheduledAt: scheduled?.components, mode,
          screenshotPath, fallbackUsername: state.username });
      } catch (error) {
        if (submit && error.code === 'UNCERTAIN') {
          await appendHistory(config.historyFile, { ts: new Date().toISOString(), ...historyFields,
            count: error.details?.count ?? count, uncertain: true, posted_ids: error.details?.posted_ids ?? [],
          }).catch(failure => console.error('保存不确定串文记录失败：', failure));
        }
        throw error;
      }
      if (submit) {
        try {
          await appendHistory(config.historyFile, { ts: new Date().toISOString(), ...historyFields, count,
            ...(scheduled ? { id: result.id } : { ids: result.posted_ids }),
          });
        } catch (error) {
          console.error('保存已发布串文记录失败：', error);
          throw new XPosterError('UNCERTAIN', 'X 已返回串文操作成功，但本地历史记录保存失败。', {
            posted_ids: result.posted_ids ?? [], ...(result.id ? { id: result.id } : {}),
            hint: `不要重试，请用户检查${scheduled ? '预排期列表' : '主页上的串文是否完整'}及数据目录权限；本次操作未能计入本地限制。`,
          });
        }
        if (result.username) await saveState({ username: result.username }).catch(error => console.error('保存用户名失败：', error));
        if (scheduled) return { data: { ok: true, scheduled: true, id: result.id, count, ...time, manage_url: URLS.scheduled } };
        const url = id => `https://x.com/${result.username || 'i'}/status/${id}`;
        const urls = result.posted_ids.map(url);
        return { data: { ok: true, posted_ids: result.posted_ids, urls, count, thread_url: inReplyTo ? url(inReplyTo) : urls[0] } };
      }
      if (result.username) await saveState({ username: result.username });
      return { data: { ok: true, posted: false, count, ...time,
        posts: posts.map(post => ({ text: post.text, images: post.images, weighted_length: post.weightedLength,
          ...(post.weightedLength > MAX_WEIGHTED_LENGTH ? { warning: '加权长度超过 280；非 Premium 账号可能需要缩短文字。' } : {}),
        })),
        ...(inReplyTo ? { in_reply_to: inReplyTo, reply_to_username: result.reply_to_username, target_text: result.target_text } : {}),
        screenshots: result.screenshots.map(shot => shot.path),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        next_step: `请向用户展示所有截图、每一条帖子的完整文字和图片${scheduled ? '及准确排期时间' : ''}。${result.warnings?.length ? '截图未覆盖整串，请在 X 中检查完整内容后再确认。' : ''}${inReplyTo ? '目标截图展示接续位置，另一个普通发帖框中的完整串文仅用于预览。' : ''}尚未发布或创建排期；用户明确确认后，使用完全相同的 posts${inReplyTo ? '、in_reply_to' : ''}${scheduled ? '、scheduled_at' : ''} 调用 ${scheduled ? 'x_thread_schedule' : 'x_thread_post'}。`,
      }, images: result.screenshots.map(shot => shot.image) };
    } finally { await browser.close().catch(error => console.error('关闭浏览器失败：', error)); }
  }, { tool: `x_thread_${mode}`, ...waitOptions });
}

export async function threadPreview(args) { return runThread(await validateThreadInput(args, 'preview'), 'preview'); }
export async function threadPost(args) { return runThread(await validateThreadInput(args, 'post'), 'post'); }
export async function threadSchedule(args) { return runThread(await validateThreadInput(args, 'schedule'), 'schedule'); }

export function preview(args) { return runCompose(args, 'preview'); }
export function post(args) { return runCompose(args, 'post'); }
export function schedule(args) { return runCompose(args, 'schedule'); }

export function listScheduled(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
    throw new XPosterError('INVALID_INPUT', '预排期列表不接受参数。');
  }
  return exclusive(async () => {
    requireUserWindowClosed();
    const browser = await openBrowser(config.headless);
    try {
      if (!await browser.isLoggedIn()) {
        throw new XPosterError('NOT_LOGGED_IN', '尚未登录 X。', { hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。' });
      }
      const scheduled = await readScheduled(browser);
      return { data: { scheduled, count: scheduled.length } };
    } finally {
      await browser.close().catch(error => console.error('关闭浏览器失败：', error));
    }
  }, { tool: 'x_list_scheduled' });
}

export function cancelScheduled(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.id !== 'string'
    || !args.id || /\D/.test(args.id) || Object.keys(args).some(key => key !== 'id')) {
    throw new XPosterError('INVALID_INPUT', 'id 必须是预排期帖的纯数字字符串。');
  }
  return exclusive(async () => {
    requireUserWindowClosed();
    const browser = await openBrowser(config.headless);
    try {
      if (!await browser.isLoggedIn()) {
        throw new XPosterError('NOT_LOGGED_IN', '尚未登录 X。', { hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。' });
      }
      const result = await deleteScheduled(browser, args.id);
      try {
        await appendHistory(config.historyFile, { ts: new Date().toISOString(), cancelled_scheduled: args.id });
      } catch (error) {
        console.error('保存取消预排期记录失败：', error);
        throw new XPosterError('UNCERTAIN', '已核验预排期帖被删除，但本地历史记录保存失败。', {
          hint: '绝不自动重试。请用户检查 X 预排期列表及数据目录权限。',
        });
      }
      return { data: { ok: true, ...result } };
    } finally {
      await browser.close().catch(error => console.error('关闭浏览器失败：', error));
    }
  }, { tool: 'x_cancel_scheduled' });
}

function articleIdInput(args, extraKeys = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.article_id !== 'string'
    || !args.article_id || /\D/.test(args.article_id) || Object.keys(args).some(key => key !== 'article_id' && !extraKeys.includes(key))) {
    throw new XPosterError('INVALID_INPUT', 'article_id 必须是文章的纯数字字符串。');
  }
  return args.article_id;
}

async function articleCoverInput(args) {
  const articleId = articleIdInput(args, ['cover']);
  if (typeof args.cover !== 'string' || !isAbsolute(expandHome(args.cover))) {
    throw new XPosterError('INVALID_INPUT', '文章 cover 必须是本地图片的绝对路径（支持 ~/）。');
  }
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extname(args.cover).toLowerCase())) {
    throw new XPosterError('INVALID_INPUT', '文章封面仅支持 jpg、jpeg、png、webp 格式。');
  }
  const { images } = await validatePostInput({ images: [args.cover] });
  return { articleId, cover: images[0] };
}

async function articleDraftInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !['markdown_path', 'title', 'cover'].includes(key))) {
    throw new XPosterError('INVALID_INPUT', '文章参数必须是包含 markdown_path 的对象。');
  }
  if (typeof args.markdown_path !== 'string' || !isAbsolute(args.markdown_path) || extname(args.markdown_path).toLowerCase() !== '.md') {
    throw new XPosterError('INVALID_INPUT', 'markdown_path 必须是本地 .md 文件的绝对路径。');
  }
  if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim())) {
    throw new XPosterError('INVALID_INPUT', '文章 title 必须是非空字符串。');
  }
  if (args.cover !== undefined && (typeof args.cover !== 'string' || !isAbsolute(args.cover))) {
    throw new XPosterError('INVALID_INPUT', '文章 cover 必须是本地图片的绝对路径。');
  }
  let source;
  let file;
  try {
    file = await open(args.markdown_path, 'r');
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_MARKDOWN_BYTES) {
      throw new XPosterError('INVALID_INPUT', 'Markdown 必须是最多 1 MB 的普通文件。');
    }
    // Read at most one byte past the limit, even if the file grows after stat.
    const buffer = Buffer.alloc(MAX_MARKDOWN_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_MARKDOWN_BYTES) throw new XPosterError('INVALID_INPUT', 'Markdown 文件不能超过 1 MB。');
    source = buffer.subarray(0, size).toString('utf8');
  } catch (error) {
    if (error instanceof XPosterError) throw error;
    throw new XPosterError('INVALID_INPUT', `无法读取 Markdown 文件：${args.markdown_path}`);
  } finally { await file?.close(); }
  return parseArticleMarkdown(source, { baseDir: dirname(args.markdown_path), title: args.title, cover: args.cover });
}

function runArticle(input, mode, onArticleId, waitOptions = {}) {
  return exclusive(async () => {
    requireUserWindowClosed();
    if (mode === 'publish') await requirePostingCapacity();
    if (mode === 'draft' || mode === 'cover') await preparePreviews();
    const browser = await openBrowser(config.headless);
    try {
      if (!await browser.isLoggedIn()) throw new XPosterError('NOT_LOGGED_IN', '尚未登录 X。', {
        hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。',
      });
      if (mode === 'draft') {
        const screenshotPath = join(config.previewsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-article.png`);
        const { screenshot, ...result } = await createArticleDraft(browser, { ...input, screenshotPath, onArticleId });
        return { data: { ok: true, ...result, screenshot: screenshotPath, warnings: input.warnings,
          next_step: '已创建新草稿，尚未发布。请向用户展示截图、标题、warnings 和 edit_url；用户也可打开 edit_url 审阅。仅在用户明确确认这一 article_id 后调用 x_article_publish。用户只要草稿时到此停止。',
        }, image: screenshot };
      }
      if (mode === 'cover') {
        const screenshotPath = join(config.previewsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-article-cover.png`);
        const { screenshot, ...result } = await setArticleCover(browser, input.articleId, { cover: input.cover, screenshotPath });
        return { data: { ok: true, ...result, screenshot: screenshot ? screenshotPath : null }, image: screenshot };
      }
      let result;
      try {
        result = mode === 'publish' ? await publishArticle(browser, input.articleId) : await deleteArticleDraft(browser, input.articleId);
      } catch (error) {
        if (mode === 'publish' && error.code === 'UNCERTAIN') {
          await appendHistory(config.historyFile, { ts: new Date().toISOString(), article_id: input.articleId, uncertain: true })
            .catch(failure => console.error('保存不确定文章发布记录失败：', failure));
        }
        throw error;
      }
      try {
        await appendHistory(config.historyFile, { ts: new Date().toISOString(), ...(mode === 'delete'
          ? { deleted_article: input.articleId } : { article_id: result.article_id, ...(result.url ? { url: result.url } : {}) }) });
      } catch (error) {
        console.error('保存文章历史记录失败：', error);
        throw new XPosterError('UNCERTAIN', 'X 文章操作已核验成功，但本地历史记录保存失败。', {
          article_id: input.articleId, ...(result.url ? { url: result.url } : {}),
          hint: '不要自动重试。请检查 https://x.com/compose/articles 和数据目录权限。',
        });
      }
      return { data: { ok: true, ...result } };
    } finally { await browser.close().catch(error => console.error('关闭浏览器失败：', error)); }
  }, { tool: `x_article_${mode}`, ...waitOptions });
}

// The CLI waits for the complete draft without the MCP response deadline.
export async function articleDraft(args) { return runArticle(await articleDraftInput(args), 'draft'); }
export async function articleCover(args) { return runArticle(await articleCoverInput(args), 'cover'); }
export async function articlePublish(args) { return runArticle({ articleId: articleIdInput(args) }, 'publish'); }
export async function articleDelete(args) { return runArticle({ articleId: articleIdInput(args) }, 'delete'); }

const jobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

function pruneJobs() {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && Date.now() - job.finishedAt >= JOB_RETENTION_MS) jobs.delete(id);
  }
}

async function jobResult(job) {
  await waitForOutcome(job.done, config.toolWaitSec * 1000);
  if (job.finishedAt !== undefined) {
    if (job.error) throw job.error;
    return { ...job.result, data: { ...job.result.data, job_id: job.id } };
  }
  return { data: {
    ok: true, status: 'in_progress', job_id: job.id, waiting_for_browser: job.waitingForBrowser,
    ...(job.articleId ? { article_id: job.articleId, edit_url: `https://x.com/compose/articles/edit/${job.articleId}` } : {}),
    elapsed_sec: Math.floor((Date.now() - job.startedAt) / 1000),
    next_step: jobNextStep(job),
  } };
}

function jobNextStep(job) {
  const poll = `请使用 job_id ${job.id} 反复调用 x_job_status，直到返回最终结果。`;
  if (job.tool === 'x_article_draft') {
    return `${poll}不要再次调用 x_article_draft，否则会创建重复草稿；遇到 UNCERTAIN 也不要重新创建，请用户检查 https://x.com/compose/articles。`;
  }
  if (job.tool === 'x_thread_preview') {
    return `${poll}不要再次调用 x_thread_preview；等此预览完成后，展示所有截图和每条帖子并请用户明确确认。遇到 UNCERTAIN，请用户检查自己的主页或预排期列表。`;
  }
  return `${poll}绝不要为这些帖子再次调用 x_thread_post 或 x_thread_schedule，否则会创建重复串文。遇到 UNCERTAIN，请用户检查${job.tool === 'x_thread_schedule' ? '预排期列表' : '自己的主页上的串文是否完整'}，并展示 posted_ids；不要重试。`;
}

function startJob(tool, run) {
  const job = { id: randomUUID(), tool, startedAt: Date.now(), waitingForBrowser: true };
  jobs.set(job.id, job);
  // Observe failures immediately so a timed-out client cannot cause an unhandled rejection.
  job.done = run(job, {
    maxWaitMs: 15 * 60 * 1000, onStart: () => { job.waitingForBrowser = false; },
  }).then(
    result => { job.result = result; },
    error => { job.error = error; },
  ).finally(() => { job.finishedAt = Date.now(); });
  return jobResult(job);
}

async function startArticleJob(args) {
  const input = await articleDraftInput(args);
  return startJob('x_article_draft', (job, waitOptions) => runArticle(input, 'draft', id => { job.articleId = id; }, waitOptions));
}

async function startThreadJob(args, mode) {
  const input = await validateThreadInput(args, mode);
  return startJob(`x_thread_${mode}`, (_job, waitOptions) => runThread(input, mode, waitOptions));
}

export function jobStatus(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.job_id !== 'string'
    || !new RegExp(UUID_PATTERN).test(args.job_id) || /\s/.test(args.job_id)
    || Object.keys(args).some(key => key !== 'job_id')) {
    throw new XPosterError('INVALID_INPUT', 'job_id 必须是任务的 UUID 字符串。');
  }
  const job = jobs.get(args.job_id.toLowerCase());
  if (!job) throw new XPosterError('INVALID_INPUT', '任务不存在或已过期。', {
    hint: '请用户检查自己的 X 主页、预排期列表和 https://x.com/compose/articles，不要盲目重新提交或创建。',
  });
  return jobResult(job);
}

export const articleStatus = jobStatus;

const jobStatusSchema = {
  type: 'object', properties: { job_id: { type: 'string', pattern: UUID_PATTERN,
    description: 'UUID job_id returned by x_article_draft or a thread tool.' } }, required: ['job_id'], additionalProperties: false,
};

const articleIdSchema = {
  type: 'object', properties: { article_id: { type: 'string', pattern: '^\\d+$', description: 'Exact numeric article id from x_article_draft, or explicitly supplied by the user.' } },
  required: ['article_id'], additionalProperties: false,
};

const postSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Post text. CJK characters and emoji count as 2, URLs as 23; non-Premium accounts have a weighted limit of 280.' },
    images: { type: 'array', items: { type: 'string' }, maxItems: 4,
      description: 'Absolute local paths to up to 4 jpg/jpeg/png/webp/gif images. Images may be at most 5 MB each; GIFs at most 15 MB.' },
  },
  additionalProperties: false,
};

const scheduledSchema = {
  ...postSchema,
  properties: {
    ...postSchema.properties,
    scheduled_at: { type: 'string', description: 'ISO 8601 date-time, at least 5 minutes in the future and no later than the current year + 2. Uses computer local time unless an offset is given. Nonzero seconds are rounded up to the next minute; preview reports the exact selected time.' },
  },
};

const threadSchema = {
  type: 'object', properties: {
    posts: { type: 'array', minItems: 1, maxItems: 25, items: postSchema,
      description: 'Ordered posts; each needs text or images. New threads need 2–25 posts; appending needs 1–25. Each post consumes one local posting-limit unit.' },
    in_reply_to: { type: 'string', pattern: '^\\d+$', description: 'Optional numeric id of the user own existing post. Cannot be combined with scheduled_at.' },
    scheduled_at: scheduledSchema.properties.scheduled_at,
  }, required: ['posts'], additionalProperties: false,
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
    description: 'Fill the X composer with text and local images, optionally set scheduled_at through the schedule dialog, take a screenshot, and discard without posting. Scheduled posts must also be previewed and explicitly confirmed first: show the screenshot, final text and exact time, then call x_schedule with identical text, images and scheduled_at; otherwise call x_post with identical text and images. Time is local unless an offset is given. Never retry UNCERTAIN. The human handles login; never request or type passwords.',
    inputSchema: scheduledSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'x_post',
    description: 'Publish one X post with text and up to 4 local images. First use x_preview, show its screenshot and final text to the user, and obtain explicit confirmation; use exactly the confirmed text and images. The human logs in themselves; never request or type passwords. Never retry an UNCERTAIN result: ask the user to check their profile to avoid a duplicate.',
    inputSchema: postSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'x_schedule',
    description: 'Create one scheduled X post using X native server-side scheduling; the computer can be off at publication time. Scheduled posts must also be previewed and explicitly confirmed first: use x_preview with scheduled_at, show the screenshot, final text and exact time, obtain confirmation, then use identical text, images and scheduled_at. Time is local unless an offset is given. Scheduling counts toward local posting limits. Never retry UNCERTAIN: ask the user to check the X scheduled list to avoid duplicates.',
    inputSchema: { ...scheduledSchema, required: ['scheduled_at'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'x_thread_preview',
    description: 'Preview every post and image of a new or appended X thread, optionally scheduled, then discard. Show ALL screenshots and every post to the user; obtain explicit confirmation before x_thread_post or x_thread_schedule with identical arguments. Append only to the user own posts; the full compose view for append is only a preview. Report weighted lengths and warnings. Long previews return in_progress with job_id; poll x_job_status until the final result and images, never call x_thread_preview again while running.',
    inputSchema: threadSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'x_thread_post',
    description: 'Publish a new thread or append sequential replies to the user own post. First call x_thread_preview, show every post and screenshot, and obtain explicit confirmation; use identical arguments. Every post counts toward local limits. Long jobs return in_progress with job_id; repeatedly poll x_job_status until the final result. Never call x_thread_post or x_thread_schedule again for these posts, because it creates a duplicate thread. Never retry UNCERTAIN; report posted_ids and ask the user to check their profile.',
    inputSchema: threadSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'x_thread_schedule',
    description: 'Schedule a NEW thread using X native scheduling. scheduled_at is required; appending is unsupported. First call x_thread_preview, show all posts, screenshots and exact time, obtain explicit confirmation and use identical arguments. Every post counts toward limits. One scheduled id represents the entire thread; x_cancel_scheduled cancels it. Long jobs return in_progress with job_id; repeatedly poll x_job_status until the final result. Never call x_thread_post or x_thread_schedule again for these posts, because it creates a duplicate thread. Never retry UNCERTAIN or auto-cancel; ask the user to check the scheduled list.',
    inputSchema: { ...threadSchema, required: ['posts', 'scheduled_at'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'x_list_scheduled',
    description: 'List scheduled X posts with ids, ISO times, text, media counts and state, sorted by time. Scheduled posts must also be previewed and explicitly confirmed first via x_preview and x_schedule with identical text, images and scheduled_at. Time is local unless an offset is given. Never retry an UNCERTAIN creation; check this list and let the user verify. Use x_cancel_scheduled only after showing the exact post and time and obtaining explicit user confirmation; the human can also cancel in X web UI.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'x_cancel_scheduled',
    description: 'Cancel (delete) one scheduled X post by its numeric id from x_list_scheduled. First list scheduled posts, show the user the exact post text and scheduled time that will be cancelled, and obtain explicit confirmation before calling this destructive tool. It verifies the target before selection and re-fetches the list after deletion to check that the target is gone and all other ids remain. Never retry UNCERTAIN: ask the user to check X immediately, especially if another post may have been removed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$', description: 'Numeric scheduled-post id returned by x_list_scheduled.' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'x_article_draft',
    description: 'Create a NEW X Article draft from an absolute local Markdown file (eligible Premium account required). Never edit existing drafts. Long articles return in_progress with a job_id; repeatedly call x_job_status until a final result. Never call x_article_draft again for the same file while in progress or after UNCERTAIN, because it creates duplicate drafts. Relative local images resolve against the Markdown directory; remote images are skipped with warnings. Always create the draft first as the preview: show the screenshot, title, warnings and edit_url to the user. Only after explicit confirmation of this exact draft call x_article_publish with its article_id; stop for draft-only requests.',
    inputSchema: { type: 'object', properties: {
      markdown_path: { type: 'string', description: 'Absolute local .md file path; maximum 1 MB, up to 50 body images.' },
      title: { type: 'string', description: 'Optional title override, ahead of front matter title and the first # heading.' },
      cover: { type: 'string', description: 'Optional absolute local jpg/jpeg/png/webp cover path, overrides front matter cover.' },
    }, required: ['markdown_path'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'x_job_status',
    description: 'Poll any in-process article or thread job by job_id without modifying the browser. Return in_progress, the final result including all images, or the original error. Repeatedly poll until completion; never re-call the creating tool while in progress or after UNCERTAIN, to avoid duplicate drafts or threads. Finished jobs expire after one hour; after restart or an unknown job, ask the user to check X before doing anything again.',
    inputSchema: jobStatusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'x_article_status',
    description: 'Backward-compatible alias of x_job_status, with identical behavior for both article and thread jobs. Poll by job_id for in_progress, the final result including images, or the original error. Never re-call the creating tool while in progress or after UNCERTAIN. Finished jobs expire after one hour.',
    inputSchema: jobStatusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'x_article_cover',
    description: 'Set or replace the cover of an existing X Article draft; it does not publish or change the body. Use only on a draft the user identified, with its exact article_id. Show the returned screenshot to the user. Does not count toward posting limits. Never retry UNCERTAIN without user review.',
    inputSchema: { ...articleIdSchema, properties: {
      ...articleIdSchema.properties,
      cover: { type: 'string', description: 'Absolute local jpg/jpeg/png/webp cover path (~/ supported), at most 5 MB. X shows a crop dialog; the default crop is applied.' },
    }, required: ['article_id', 'cover'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'x_article_publish',
    description: 'PUBLICLY publish one X Article draft. First create it with x_article_draft, show its screenshot, title, warnings and edit_url, and obtain explicit user confirmation of that exact article_id. Counts toward local posting limits. Never retry UNCERTAIN: ask the user to check the Published tab at https://x.com/compose/articles to avoid duplicates.',
    inputSchema: articleIdSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'x_article_delete',
    description: 'Permanently delete one X Article DRAFT. Only delete drafts this session created, or an article_id the user explicitly supplied and confirmed. Show the exact id/edit_url and obtain confirmation first; never guess or select another draft. Does not count toward posting limits. Never retry UNCERTAIN: ask the user to check https://x.com/compose/articles.',
    inputSchema: articleIdSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

const handlers = { x_status: status, x_login: login, x_preview: preview, x_post: post, x_schedule: schedule, x_list_scheduled: listScheduled, x_cancel_scheduled: cancelScheduled,
  x_thread_preview: args => startThreadJob(args, 'preview'), x_thread_post: args => startThreadJob(args, 'post'),
  x_thread_schedule: args => startThreadJob(args, 'schedule'), x_job_status: jobStatus,
  x_article_draft: startArticleJob, x_article_status: articleStatus, x_article_cover: articleCover, x_article_publish: articlePublish, x_article_delete: articleDelete };
export function hasTool(name) { return Object.hasOwn(handlers, name); }

export async function callTool(name, args) {
  pruneJobs();
  try {
    if (!hasTool(name)) throw new XPosterError('INVALID_INPUT', '未知工具。');
    const { data, image, images = [] } = await handlers[name](args);
    const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
    for (const item of [image, ...images]) {
      if (Buffer.isBuffer(item)) content.push({ type: 'image', data: item.toString('base64'), mimeType: 'image/png' });
    }
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
