import { mkdir, readdir, stat, unlink, open } from 'node:fs/promises';
import { join, dirname, isAbsolute, extname } from 'node:path';
import { Browser, findChrome, openPlainWindow } from './chrome.mjs';
import { config, ensureHome, loadState, saveState } from './config.mjs';
import { XPosterError } from './errors.mjs';
import { appendHistory, checkRateLimit, readHistory } from './limits.mjs';
import { MAX_WEIGHTED_LENGTH, validatePostInput, parseScheduledAt } from './validate.mjs';
import { compose, listScheduled as readScheduled, cancelScheduled as deleteScheduled, URLS } from './x.mjs';
import { parseArticleMarkdown, MAX_MARKDOWN_BYTES } from './markdown.mjs';
import { createArticleDraft, publishArticle, deleteArticleDraft } from './article.mjs';

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
  });
}

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
  });
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
  });
}

function articleIdInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.article_id !== 'string'
    || !args.article_id || /\D/.test(args.article_id) || Object.keys(args).some(key => key !== 'article_id')) {
    throw new XPosterError('INVALID_INPUT', 'article_id 必须是文章的纯数字字符串。');
  }
  return args.article_id;
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

async function runArticle(args, mode) {
  const input = mode === 'draft' ? await articleDraftInput(args) : { articleId: articleIdInput(args) };
  return exclusive(async () => {
    requireUserWindowClosed();
    if (mode === 'publish') {
      const rate = limits(await readHistory(config.historyFile));
      if (!rate.allowed) throw new XPosterError('RATE_LIMITED', `请等待 ${rate.retryAfterSec} 秒后再发布文章。`, {
        retry_after_sec: rate.retryAfterSec, posts_last_24h: rate.postsLast24h, hint: '请告诉用户等待时间，不要循环重试。',
      });
    }
    if (mode === 'draft') await preparePreviews();
    const browser = await openBrowser(config.headless);
    try {
      if (!await browser.isLoggedIn()) throw new XPosterError('NOT_LOGGED_IN', '尚未登录 X。', {
        hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。',
      });
      if (mode === 'draft') {
        const screenshotPath = join(config.previewsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-article.png`);
        const { screenshot, ...result } = await createArticleDraft(browser, { ...input, screenshotPath });
        return { data: { ok: true, ...result, screenshot: screenshotPath, warnings: input.warnings,
          next_step: '已创建新草稿，尚未发布。请向用户展示截图、标题、warnings 和 edit_url；用户也可打开 edit_url 审阅。仅在用户明确确认这一 article_id 后调用 x_article_publish。用户只要草稿时到此停止。',
        }, image: screenshot };
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
  });
}

export function articleDraft(args) { return runArticle(args, 'draft'); }
export function articlePublish(args) { return runArticle(args, 'publish'); }
export function articleDelete(args) { return runArticle(args, 'delete'); }

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
    description: 'Create a NEW X Article draft from an absolute local Markdown file (eligible Premium account required). Never edit existing drafts. Relative local images resolve against the Markdown directory; remote images are skipped with warnings. Always create the draft first as the preview: show the screenshot, title, warnings and edit_url to the user. Only after explicit confirmation of this exact draft call x_article_publish with its article_id; stop for draft-only requests. Never retry UNCERTAIN without user review.',
    inputSchema: { type: 'object', properties: {
      markdown_path: { type: 'string', description: 'Absolute local .md file path; maximum 1 MB, up to 50 body images.' },
      title: { type: 'string', description: 'Optional title override, ahead of front matter title and the first # heading.' },
      cover: { type: 'string', description: 'Optional absolute local jpg/jpeg/png/webp cover path, overrides front matter cover.' },
    }, required: ['markdown_path'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
  x_article_draft: articleDraft, x_article_publish: articlePublish, x_article_delete: articleDelete };
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
