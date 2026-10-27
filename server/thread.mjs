import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { XPosterError } from './errors.mjs';
import { expandHome } from './config.mjs';
import { CREATE_POST_URL, SELECTORS, openComposer, fillText, waitUntilReady, setSchedule,
  readUsername, parseCreatePostResponse, parseCreateScheduledResponse, captureUIDiagnostics } from './x.mjs';

const normalized = text => text == null ? '' : typeof text === 'string' ? text.trim().replace(/\s+/gu, ' ') : null;
const editorAt = index => `[data-testid=tweetTextarea_${index}]`;
const replyURL = id => `https://x.com/intent/post?in_reply_to=${id}`;
const SCHEDULE_URL = /\/i\/api\/graphql\/[^/]+\/CreateScheduledTweet\b/;

export function uncertainThread(postedIds = [], scheduled = false, count) {
  return new XPosterError('UNCERTAIN', scheduled ? '无法确认串文预排期的完整内容。' : '无法确认串文是否完整发布。', {
    posted_ids: postedIds, ...(count === undefined ? {} : { count }),
    hint: scheduled ? '不要重试，请用户检查 X 预排期列表：https://x.com/compose/post/unsent/scheduled'
      : '不要重试，请用户检查主页上的串文是否完整。',
  });
}

function parseJSON(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function requestPosts(postData) {
  const variables = parseJSON(postData)?.variables;
  const request = variables?.post_tweet_request ?? variables;
  if (!request || typeof request !== 'object') return [];
  return [request, ...(Array.isArray(request.thread_tweets) ? request.thread_tweets : [])]
    .map(post => normalized(post.tweet_text ?? post.status));
}

function responseIds(body) {
  const ids = [];
  function visit(value, threadItem = false) {
    if (!value || typeof value !== 'object') return;
    if (threadItem && typeof value.rest_id === 'string' && /^\d+$/.test(value.rest_id)) {
      ids.push(value.rest_id);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'tweet_results') {
        const id = parseCreatePostResponse(JSON.stringify({ data: { tweet_results: child } }))?.id;
        if (id) ids.push(id);
        const result = child?.result?.tweet ?? child?.result;
        if (Array.isArray(result?.thread_tweets)) {
          for (const item of result.thread_tweets) visit(item, true);
        }
      } else if (key === 'thread_tweets' && Array.isArray(child)) {
        for (const item of child) visit(item, true);
      } else visit(child);
    }
  }
  visit(parseJSON(body)?.data);
  return [...new Set(ids)];
}

export function mapThreadResponses(records, posts) {
  const expected = posts.map(post => normalized(post.text));
  const mapped = Array(posts.length).fill(null);
  let index = 0;
  for (const record of records) {
    const texts = requestPosts(record.postData);
    if (texts.length > 1) {
      if (index !== 0 || texts.length !== expected.length || texts.some((text, i) => text !== expected[i])) continue;
      const ids = responseIds(record.body);
      for (let i = 0; i < Math.min(ids.length, mapped.length); i++) mapped[i] = ids[i];
      index = expected.length;
    } else if (index < expected.length && texts.length === 1 && texts[0] === expected[index]) {
      mapped[index++] = responseIds(record.body)[0] ?? null;
    }
  }
  return mapped.filter((id, i) => id && mapped.indexOf(id) === i);
}

export function verifyScheduledThread(postData, posts) {
  const request = parseJSON(postData)?.variables?.post_tweet_request;
  if (!request || !Array.isArray(request.thread_tweets) || request.thread_tweets.length !== posts.length - 1) return false;
  const texts = [request, ...request.thread_tweets].map(post => normalized(post?.status));
  return texts.length === posts.length && texts.every((text, i) => text === normalized(posts[i].text));
}

// Keep request order even when response bodies finish in a different order.
export function watchThreadResponses(page, posts, { scheduled = false, timeout = 90000 } = {}) {
  const records = new Map();
  const subscriptions = [];
  let finished = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const outcome = () => {
    if (scheduled) {
      for (const record of records.values()) {
        const parsed = parseCreateScheduledResponse(record.body);
        if (parsed?.id && verifyScheduledThread(record.postData, posts)) return { id: parsed.id };
      }
      return null;
    }
    const posted_ids = mapThreadResponses([...records.values()], posts);
    return posted_ids.length === posts.length ? { posted_ids } : null;
  };
  const finish = result => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    for (const off of subscriptions) off();
    resolveDone(result);
  };
  const check = () => { if (!finished) { const result = outcome(); if (result) finish(result); } };
  const timer = setTimeout(() => finish(null), timeout);
  subscriptions.push(page.on('Network.requestWillBeSent', event => {
    const request = event.request;
    if (request.method !== 'POST' || !(scheduled ? SCHEDULE_URL : CREATE_POST_URL).test(request.url)) return;
    const record = { postData: request.postData, body: null };
    records.set(event.requestId, record);
    if (!request.postData) {
      void page.send('Network.getRequestPostData', { requestId: event.requestId }).then(result => {
        record.postData = result.postData;
        check();
      }, () => {});
    }
  }));
  subscriptions.push(page.on('Network.responseReceived', event => {
    const record = records.get(event.requestId);
    if (record) record.response = event.response;
  }));
  subscriptions.push(page.on('Network.loadingFinished', event => {
    const record = records.get(event.requestId);
    if (!record?.response) return;
    void page.send('Network.getResponseBody', { requestId: event.requestId }).then(result => {
      record.body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
      check();
      if (scheduled && record.postData && !verifyScheduledThread(record.postData, posts)) finish(null);
    }, () => {});
  }));
  subscriptions.push(page.on('Network.loadingFailed', event => {
    const record = records.get(event.requestId);
    if (record) record.failed = true;
  }));
  return { done, cancel: () => finish(null),
    postedIds: () => mapThreadResponses([...records.values()], posts) };
}

async function submitThread(page, scope, posts, scheduled) {
  await page.send('Network.enable');
  const watcher = watchThreadResponses(page, posts, { scheduled });
  try {
    try { await page.click(scope + SELECTORS.postButton); }
    catch (error) {
      if (error instanceof XPosterError && error.code === 'UI_CHANGED') throw error;
      throw uncertainThread(watcher.postedIds(), scheduled, posts.length);
    }
    const result = await watcher.done;
    if (!result) throw uncertainThread(watcher.postedIds(), scheduled, posts.length);
    return result;
  } finally { watcher.cancel(); }
}

async function clickContainer(page, container, editor) {
  // A newly added post animates in, so its container is briefly covered; retry, then focus directly.
  const deadline = Date.now() + 3000;
  for (;;) {
    try { return await page.click(container); }
    catch (error) {
      if (!(error instanceof XPosterError && error.code === 'UI_CHANGED' && /遮挡/.test(error.message))) throw error;
      if (Date.now() >= deadline) return page.call(selector => document.querySelector(selector)?.focus(), editor);
      await delay(250);
    }
  }
}

async function focusThreadEditor(page, scope, index) {
  const editor = scope + editorAt(index);
  const container = scope + `[data-testid=tweetTextarea_${index}RichTextInputContainer]`;
  if (await page.call(selector => !!document.querySelector(selector), container)) {
    await clickContainer(page, container, editor);
  } else {
    const point = await page.call(selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      el.focus();
      const parent = el.parentElement;
      parent?.scrollIntoView({ block: 'nearest' });
      const rect = parent?.getBoundingClientRect();
      return rect?.width > 0 && rect.height > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    }, editor);
    if (!point) throw new XPosterError('UI_CHANGED', '无法定位串文图片所属的编辑器。', { selector: editor });
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left',
        ...(type === 'mouseMoved' ? {} : { clickCount: 1 }),
      });
    }
  }
  if (!await page.waitFor(selector => {
    const el = document.querySelector(selector);
    return !!el && (document.activeElement === el || el.contains(document.activeElement));
  }, [editor], { timeout: 2000 })) {
    throw new XPosterError('UI_CHANGED', '无法确认串文编辑器已获得焦点，已停止附加图片。', { selector: editor });
  }
}

// This function runs in the page; all inspected and scrolled nodes stay inside the composer.
function composerState(reply, { index, offset } = {}) {
  const editor = document.querySelector('[role=dialog] [data-testid=tweetTextarea_0]')
    ?? (reply ? document.querySelector('[data-testid=tweetTextarea_0]') : null);
  if (!editor) return null;
  let root = editor.closest('[role=dialog]');
  if (!root && reply) {
    root = editor.parentElement;
    while (root && root !== document.body && root !== document.documentElement
      && !root.querySelector('[data-testid=tweet], [data-testid=tweetText]')) root = root.parentElement;
  }
  if (!root || root === document.body || root === document.documentElement) return null;
  if (index !== undefined) {
    const current = root.querySelector(`[data-testid=tweetTextarea_${index}]`);
    const next = root.querySelector(`[data-testid=tweetTextarea_${index + 1}]`);
    if (!current) return false;
    return [...root.querySelectorAll('[data-testid=attachments]')].some(attachment =>
      !current.contains(attachment) && !!(current.compareDocumentPosition(attachment) & Node.DOCUMENT_POSITION_FOLLOWING)
      && (!next || !!(attachment.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)));
  }
  const scroller = [root, ...root.querySelectorAll('*')].find(element => element.clientHeight > 0
    && element.scrollHeight > element.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY));
  if (scroller && offset !== undefined) scroller.scrollTop = offset;
  const rect = root.getBoundingClientRect();
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.min(window.innerWidth, rect.right) - x;
  const height = Math.min(window.innerHeight, rect.bottom) - y;
  const needed = Math.max(root.scrollHeight, rect.height + (scroller ? scroller.scrollHeight - scroller.clientHeight : 0)) + 32;
  return {
    viewport: { width: window.innerWidth, height: Math.min(4000, Math.ceil(Math.max(window.innerHeight, needed))) },
    clip: width > 0 && height > 0 ? { x, y, width, height } : null,
    clipped: width < rect.width - 1 || height < rect.height - 1,
    scroll: scroller ? { top: scroller.scrollTop, height: scroller.clientHeight, total: scroller.scrollHeight } : null,
  };
}

export async function fillThread(page, scope, posts) {
  for (const [index, post] of posts.entries()) {
    if (index) await page.click(scope + SELECTORS.addButton);
    const editor = scope + editorAt(index);
    if (!await page.waitFor(selector => !!document.querySelector(selector), [editor], { timeout: 10000 })) {
      throw new XPosterError('UI_CHANGED', '找不到串文编辑器。', { selector: editor });
    }
    if (post.text) await fillText(page, editor, post.text);
    if (post.images.length) {
      await focusThreadEditor(page, scope, index);
      await page.setFiles(scope + SELECTORS.fileInput, post.images);
      if (!await page.waitFor(composerState, [!scope, { index }], { timeout: 10000 })) {
        throw new XPosterError('UI_CHANGED', '图片未出现在当前帖子编辑器之后、下一条帖子之前，已停止。', { selector: editor });
      }
    }
    await waitUntilReady(page, scope, post.images, post.weightedLength, editor);
  }
}

export async function checkOwnReply(page, scope, fallbackUsername) {
  const username = await readUsername(page) || fallbackUsername;
  const target = await page.waitFor(scope => {
    const editor = document.querySelector(scope + '[data-testid=tweetTextarea_0]');
    if (!editor) return null;
    const root = editor.closest('[role=dialog]') ?? document.querySelector('main') ?? document.body;
    // Post text and display names are untrusted; only read the reply UI label.
    const content = '[data-testid=tweet], [data-testid=tweetText], [data-testid^=tweetTextarea_], [data-testid=User-Name]';
    const handles = new Set();
    for (const element of root.querySelectorAll('div, span')) {
      if (element.closest(content) || element.querySelector(content)) continue;
      const match = (element.innerText || '').trim().match(/^(?:回复\s*@|Replying\s+to\s+@)([a-z0-9_]+)(?![a-z0-9_])/i);
      if (match) handles.add(match[1].toLowerCase());
    }
    if (handles.size !== 1) return null;
    return { reply_to_username: [...handles][0], target_text: root.querySelector('[data-testid=tweetText]')?.innerText?.slice(0, 280) ?? '' };
  }, [scope], { timeout: 10000 });
  if (typeof username !== 'string' || !/^[a-z0-9_]+$/i.test(username) || !target?.reply_to_username) {
    throw new XPosterError('UI_CHANGED', '无法确认回复对象或当前登录用户名，已停止接续。');
  }
  if (username.toLowerCase() !== target.reply_to_username.toLowerCase()) {
    throw new XPosterError('INVALID_INPUT', '只能接在自己的帖子后面。');
  }
  return { username, ...target };
}

const MAX_PREVIEW_IMAGES = 8;
const PREVIEW_WARNING = '串文较长，截图只覆盖前面部分，请在 X 中检查';

export async function captureThread(page, screenshotPath, { label = 'thread', reply = false, maxImages = MAX_PREVIEW_IMAGES } = {}) {
  const initial = await page.call(composerState, reply);
  if (!initial) throw new XPosterError('UI_CHANGED', '找不到完整的发帖预览区域，已停止截图。');
  const screenshots = [];
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { ...initial.viewport, deviceScaleFactor: 1, mobile: false });
    let offset = 0;
    let previous = -1;
    while (screenshots.length < Math.min(MAX_PREVIEW_IMAGES, maxImages)) {
      const view = await page.call(composerState, reply, { offset });
      if (!view?.clip || view.scroll && offset > 0 && view.scroll.top <= previous) {
        throw new XPosterError('UI_CHANGED', '无法定位或滚动发帖预览区域，已停止截图。');
      }
      const result = await page.send('Page.captureScreenshot', {
        format: 'png', clip: { ...view.clip, scale: 1 }, captureBeyondViewport: false,
      });
      const image = Buffer.from(result.data, 'base64');
      const path = screenshotPath.replace(/\.png$/, `-${label}-${screenshots.length + 1}.png`);
      await writeFile(path, image, { mode: 0o600 });
      screenshots.push({ path, image });
      const scroll = view.scroll;
      if (!scroll || scroll.top + scroll.height >= scroll.total - 1) return { screenshots, truncated: view.clipped };
      previous = scroll.top;
      offset = Math.min(scroll.total - scroll.height, scroll.top + Math.max(1, Math.floor(scroll.height * 0.9)));
    }
    return { screenshots, truncated: true };
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

async function withComposer(browser, url, screenshotPath, action) {
  const page = await browser.newPage();
  try { return await action(page, await openComposer(page, url, screenshotPath)); }
  catch (error) {
    if (error instanceof XPosterError && error.code === 'UI_CHANGED' && !Object.hasOwn(error.details, 'diagnostics')) {
      error.details.diagnostics = await captureUIDiagnostics(page, screenshotPath);
    }
    throw error;
  }
  finally { await page.close().catch(error => console.error('关闭串文标签页失败：', error)); }
}

export async function composeThread(browser, { posts, inReplyTo, scheduledAt, mode, screenshotPath, fallbackUsername }) {
  const screenshots = [];
  const warnings = new Set();
  let target;
  let username = null;
  if (inReplyTo) {
    const postedIds = [];
    let replyTo = inReplyTo;
    for (const post of mode === 'preview' ? posts.slice(0, 1) : posts) {
      try {
        await withComposer(browser, replyURL(replyTo), screenshotPath, async (page, scope) => {
          const own = await checkOwnReply(page, scope, username || fallbackUsername);
          username = own.username;
          target ??= own;
          await fillThread(page, scope, [post]);
          if (mode === 'preview') {
            const captured = await captureThread(page, screenshotPath, { label: 'target', reply: true, maxImages: 1 });
            screenshots.push(...captured.screenshots);
            if (captured.truncated) warnings.add(PREVIEW_WARNING);
          }
          else {
            const result = await submitThread(page, scope, [post], false);
            postedIds.push(...result.posted_ids);
            replyTo = postedIds.at(-1);
          }
        });
      } catch (error) {
        if (postedIds.length || error.code === 'UNCERTAIN') {
          throw uncertainThread([...new Set([...postedIds, ...(error.details?.posted_ids ?? [])])], false,
            postedIds.length + (error.code === 'UNCERTAIN' ? error.details?.count ?? 1 : 0));
        }
        throw error;
      }
    }
    if (mode !== 'preview') return { username, posted_ids: postedIds };
  }
  return withComposer(browser, undefined, screenshotPath, async (page, scope) => {
    await fillThread(page, scope, posts);
    if (scheduledAt) {
      await setSchedule(page, scope, scheduledAt);
      for (const [index, post] of posts.entries()) {
        await waitUntilReady(page, scope, post.images, post.weightedLength, scope + editorAt(index));
      }
    }
    username = await readUsername(page) || username;
    if (mode !== 'preview') return { username, ...await submitThread(page, scope, posts, mode === 'schedule') };
    const captured = await captureThread(page, screenshotPath, { maxImages: MAX_PREVIEW_IMAGES - screenshots.length });
    screenshots.push(...captured.screenshots);
    if (captured.truncated) warnings.add(PREVIEW_WARNING);
    return { username, screenshots, warnings: [...warnings], ...(target ? { reply_to_username: target.reply_to_username, target_text: target.target_text } : {}) };
  });
}

function splitThreadMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end >= 0 && lines.slice(1, end).every(line => !line.trim() || /^[^:\s][^:]*:.*$/.test(line.trim()))) {
      lines.splice(0, end + 1);
    }
  }
  const parts = [];
  let current = [];
  let fence = null;
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
    } else if (/^[\t ]*---[\t ]*$/.test(line)) {
      parts.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  parts.push(current.join('\n'));
  return parts;
}

export async function readThreadFile(path) {
  const file = resolve(expandHome(path));
  let source;
  try { source = await readFile(file, 'utf8'); }
  catch { throw new XPosterError('INVALID_INPUT', '无法读取串文文件。'); }
  let posts;
  if (extname(file).toLowerCase() === '.json') {
    posts = parseJSON(source);
    if (!Array.isArray(posts)) throw new XPosterError('INVALID_INPUT', '串文 JSON 必须是帖子数组。');
  } else if (extname(file).toLowerCase() === '.md') {
    posts = splitThreadMarkdown(source).map(part => {
      const images = [];
      const text = part.replace(/!\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g, (_, path) => {
        images.push(path.startsWith('<') ? path.slice(1, -1) : path);
        return '';
      }).trim();
      return { text, images };
    });
    const hasContent = post => post.text || post.images.length;
    const first = posts.findIndex(hasContent);
    posts = first < 0 ? [] : posts.slice(first, posts.findLastIndex(hasContent) + 1);
    for (const [index, post] of posts.entries()) {
      if (!hasContent(post)) {
        throw new XPosterError('INVALID_INPUT', `第 ${index + 1} 条帖子为空，请删除多余的 --- 分隔线。`);
      }
    }
  } else throw new XPosterError('INVALID_INPUT', '串文文件仅支持 .json 或 .md。');
  return posts.map(post => {
    if (!post || typeof post !== 'object' || Array.isArray(post)) throw new XPosterError('INVALID_INPUT', '每条帖子必须是对象。');
    if (post.images !== undefined && (!Array.isArray(post.images) || post.images.some(path => typeof path !== 'string' || !path.trim()))) {
      throw new XPosterError('INVALID_INPUT', '串文图片必须是非空路径数组。');
    }
    return { ...post, ...(post.images ? { images: post.images.map(path => resolve(dirname(file), expandHome(path))) } : {}) };
  });
}
