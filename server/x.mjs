import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { XPosterError } from './errors.mjs';
import { MAX_WEIGHTED_LENGTH } from './validate.mjs';

export const URLS = {
  home: 'https://x.com/home', login: 'https://x.com/i/flow/login', compose: 'https://x.com/compose/post',
};
// X's internal test ids. When X changes its UI, this is the one place to update.
export const SELECTORS = {
  dialog: '[role=dialog]',
  editor: '[data-testid=tweetTextarea_0]',
  fileInput: 'input[data-testid=fileInput]',
  postButton: '[data-testid=tweetButton]',
  attachments: '[data-testid=attachments]',
  toast: '[data-testid=toast]',
  profileLink: '[data-testid=AppTabBar_Profile_Link]',
};
const CREATE_POST_URL = /\/i\/api\/graphql\/[^/]+\/Create(?:Tweet|Post|NoteTweet)\b/;

export function parseCreatePostResponse(body) {
  let json;
  try { json = JSON.parse(body); } catch { return null; }
  if (!json || typeof json !== 'object') return null;
  function findId(value, inResults = false) {
    if (!value || typeof value !== 'object') return null;
    if (inResults && typeof value.rest_id === 'string' && /^\d+$/.test(value.rest_id)) return value.rest_id;
    for (const [key, nested] of Object.entries(value)) {
      const id = findId(nested, inResults || key === 'tweet_results');
      if (id) return id;
    }
    return null;
  }
  const id = findId(json.data);
  if (id) return { id };
  if (Array.isArray(json.errors) && json.errors.length) {
    return {
      message: json.errors.map(error => error?.message).filter(Boolean).join('；'),
      codes: json.errors.map(error => error?.code).filter(code => code !== undefined && code !== null),
    };
  }
  return null;
}

export async function readUsername(page, timeout = 0) {
  const read = selector => {
    const href = document.querySelector(selector)?.getAttribute('href');
    return href?.match(/^\/([^/?#]+)\/?$/)?.[1] ?? null;
  };
  return timeout > 0
    ? page.waitFor(read, [SELECTORS.profileLink], { timeout })
    : page.call(read, SELECTORS.profileLink);
}

function editorState(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  return { hasContent: !!el.textContent?.trim() || !!el.querySelector('img'), text: el.innerText || '' };
}

async function clearEditor(page, selector) {
  const focused = await page.call(selector => {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.focus();
    return true;
  }, selector);
  if (focused) {
    await page.press('SelectAll');
    await page.press('Backspace');
    if (await page.waitFor(selector => {
      const el = document.querySelector(selector);
      return el && !el.textContent?.trim() && !el.querySelector('img');
    }, [selector], { timeout: 2000 })) return;
  }
  throw new XPosterError('UI_CHANGED', '无法清空发帖编辑器。', { selector });
}

async function verifyText(page, selector, text) {
  return page.waitFor((selector, expected) => {
    const el = document.querySelector(selector);
    if (!el || (!el.textContent?.trim() && !el.querySelector('img'))) return false;
    const comparable = value => value.replace(/[\s\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F\u20E3]/gu, '');
    return comparable(el.innerText || '') === comparable(expected);
  }, [selector, text], { timeout: 2000 });
}

async function fillText(page, selector, text) {
  const state = await page.call(editorState, selector);
  if (!state) throw new XPosterError('UI_CHANGED', '找不到发帖编辑器。', { selector });
  if (state.hasContent) await clearEditor(page, selector);
  let pasted = false;
  try {
    pasted = await page.call((selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.focus();
      const data = new DataTransfer();
      data.setData('text/plain', value);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return true;
    }, selector, text);
  } catch { /* Some editor versions ignore or reject synthetic clipboard events. */ }
  if (pasted && await verifyText(page, selector, text)) return;
  await clearEditor(page, selector);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.press('Enter');
    if (lines[i]) await page.insertText(lines[i]);
  }
  if (!await verifyText(page, selector, text)) {
    throw new XPosterError('UI_CHANGED', '填入的文字与预期不一致。', {
      selector, hint: '请查看 Chrome 窗口中的文字，可能是 X 编辑器发生了变化。',
    });
  }
}

function textRejected(weightedLength, toast) {
  return new XPosterError('TEXT_REJECTED', `X 暂未允许发布此文字。${toast ? `提示：${toast}` : ''}`, {
    weighted_length: weightedLength,
    hint: weightedLength > MAX_WEIGHTED_LENGTH
      ? '中日韩文字和 emoji 计 2，链接计 23；非 Premium 账号上限为 280，请缩短文字。'
      : '请用户查看 Chrome 窗口中的提示。',
  });
}

async function waitUntilReady(page, scope, images, weightedLength) {
  const deadline = Date.now() + (images.length ? 120000 : 15000);
  let readyPolls = 0;
  let missingSince = null;
  let disabledSince = null;
  let snapshot;
  let settled = false;
  while (true) {
    snapshot = await page.call((scope, selectors) => {
      const button = document.querySelector(scope + selectors.postButton);
      const attachments = [...document.querySelectorAll(scope + selectors.attachments)];
      return {
        button: !button ? 'missing' : button.disabled || button.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled',
        hasAttachments: attachments.length > 0,
        uploading: attachments.some(el => el.querySelector('[role=progressbar]') || /uploading|processing|上传|处理/i.test(el.innerText)),
        toast: document.querySelector(selectors.toast)?.innerText || null,
      };
    }, scope, SELECTORS);
    const now = Date.now();
    settled = !snapshot.uploading && (!images.length || snapshot.hasAttachments);
    readyPolls = snapshot.button === 'enabled' && settled ? readyPolls + 1 : 0;
    if (readyPolls >= 2) return;
    missingSince = snapshot.button === 'enabled' && images.length && !snapshot.hasAttachments ? missingSince ?? now : null;
    if (missingSince !== null && now - missingSince >= 10000) {
      throw new XPosterError('UI_CHANGED', '无法确认图片已附加，已停止发布。', {
        selector: scope + SELECTORS.attachments, hint: '请查看 Chrome 窗口中的图片是否上传成功。',
      });
    }
    disabledSince = snapshot.button === 'disabled' && settled ? disabledSince ?? now : null;
    if (disabledSince !== null && now - disabledSince > 8000) throw textRejected(weightedLength, snapshot.toast);
    if (now >= deadline) break;
    await delay(500);
  }
  if (snapshot.button === 'missing') {
    throw new XPosterError('UI_CHANGED', '找不到发布按钮。', { selector: scope + SELECTORS.postButton });
  }
  if (images.length && !settled) {
    throw new XPosterError('UPLOAD_FAILED', `图片上传未完成。${snapshot.toast ? `提示：${snapshot.toast}` : ''}`, {
      hint: '请检查图片格式和大小，并检查网络连接。',
    });
  }
  throw textRejected(weightedLength, snapshot.toast);
}

function watchCreateResponse(page) {
  let requestId;
  let finished = false;
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const subscriptions = [];
  const finish = outcome => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    for (const off of subscriptions) off();
    resolve(outcome);
  };
  const timer = setTimeout(() => finish(null), 60000);
  subscriptions.push(page.on('Network.responseReceived', event => {
    if (!requestId && CREATE_POST_URL.test(event.response.url)) requestId = event.requestId;
  }));
  subscriptions.push(page.on('Network.loadingFinished', event => {
    if (event.requestId !== requestId || !requestId) return;
    page.send('Network.getResponseBody', { requestId }).then(result => {
      finish(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
    }, () => finish(null));
  }));
  subscriptions.push(page.on('Network.loadingFailed', event => {
    if (event.requestId === requestId && requestId) finish(null);
  }));
  return { done, cancel: () => finish(null) };
}

function uncertain(toast) {
  return new XPosterError('UNCERTAIN', `无法确认帖子是否已经发布。${toast ? `提示：${toast}` : ''}`, {
    hint: '不要自动重试，以免重复发布。请用户到自己的 X 主页确认。',
  });
}

async function submitPost(page, selector) {
  await page.send('Network.enable');
  const watcher = watchCreateResponse(page);
  try {
    try { await page.click(selector); }
    catch (error) {
      if (error instanceof XPosterError && error.code === 'UI_CHANGED') throw error;
      throw uncertain();
    }
    const parsed = parseCreatePostResponse(await watcher.done);
    if (parsed?.id) return parsed.id;
    if (parsed?.codes) {
      const hints = {
        186: '文字过长，请缩短文字。', 187: '与近期帖子重复，请勿重复发布。',
        226: 'X 认为操作疑似自动化，请暂停操作或由用户手动发布。', 344: '已达到 X 的每日发布上限，请稍后再试。',
      };
      throw new XPosterError('POST_REJECTED', `X 拒绝发布。${parsed.message ? `提示：${parsed.message}` : ''}`, {
        x_error_codes: parsed.codes,
        hint: parsed.codes.map(code => hints[code]).filter(Boolean).join(' ') || '请用户查看 Chrome 窗口中的提示。',
      });
    }
    let outcome;
    try {
      outcome = await page.call(selector => {
        const toast = document.querySelector(selector);
        const href = toast?.querySelector('a[href*="/status/"]')?.getAttribute('href');
        return { id: href?.match(/\/status\/(\d+)/)?.[1] ?? null, toast: toast?.innerText || null };
      }, SELECTORS.toast);
    } catch { throw uncertain(); }
    if (outcome.id) return outcome.id;
    throw uncertain(outcome.toast);
  } finally {
    watcher.cancel();
  }
}

export async function compose(browser, { text, images, submit, screenshotPath, weightedLength }) {
  const page = await browser.newPage();
  try {
    await page.navigate(URLS.compose);
    const state = await page.waitFor(selector => {
      const path = location.pathname;
      if (path.startsWith('/login') || path.startsWith('/i/flow/')) return 'login';
      if (path.startsWith('/account/access')) return 'challenge';
      return document.querySelector(selector) ? 'editor' : null;
    }, [SELECTORS.editor], { timeout: 45000 });
    if (state === 'login') {
      throw new XPosterError('NOT_LOGGED_IN', 'X 登录状态已失效。', { hint: '请调用 x_login，让用户自己在 Chrome 窗口中登录。' });
    }
    if (state === 'challenge') {
      throw new XPosterError('ACCOUNT_CHALLENGE', 'X 要求完成账号验证。', {
        hint: '请调用 x_login 打开窗口，让用户完成验证；不要尝试绕过验证码。',
      });
    }
    if (!state) {
      throw new XPosterError('UI_CHANGED', '等待发帖编辑器超时。', {
        selector: SELECTORS.editor, hint: '可能是网络较慢或 X 页面发生了变化，请查看 Chrome 窗口。',
      });
    }
    const modal = await page.waitFor(selector => !!document.querySelector(selector),
      [`${SELECTORS.dialog} ${SELECTORS.editor}`], { timeout: 8000 });
    const scope = modal ? `${SELECTORS.dialog} ` : '';
    if (text) await fillText(page, scope + SELECTORS.editor, text);
    if (images.length) await page.setFiles(scope + SELECTORS.fileInput, images);
    await waitUntilReady(page, scope, images, weightedLength);
    const clip = await page.call((editorSelector, buttonSelector) => {
      let el = document.querySelector(editorSelector);
      const button = document.querySelector(buttonSelector);
      if (!button) return null;
      while (el && !el.contains(button)) el = el.parentElement;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = Math.max(0, rect.x + scrollX - 12);
      const y = Math.max(0, rect.y + scrollY - 12);
      return { x, y, width: rect.right + scrollX + 12 - x, height: rect.bottom + scrollY + 12 - y };
    }, scope + SELECTORS.editor, scope + SELECTORS.postButton);
    const screenshot = await page.screenshot(clip);
    await writeFile(screenshotPath, screenshot, { mode: 0o600 });
    const username = await readUsername(page);
    if (!submit) return { screenshot, username };
    const id = await submitPost(page, scope + SELECTORS.postButton);
    return { screenshot, username, id };
  } finally {
    // Cleanup failures must not turn a confirmed post into a retryable failure.
    await page.close().catch(error => console.error('关闭发帖标签页失败：', error));
  }
}
