import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { XPosterError } from './errors.mjs';
import { MAX_WEIGHTED_LENGTH } from './validate.mjs';

export const URLS = {
  scheduled: 'https://x.com/compose/post/unsent/scheduled',
  home: 'https://x.com/home', login: 'https://x.com/i/flow/login', compose: 'https://x.com/compose/post',
};
// X's internal test ids. When X changes its UI, this is the one place to update.
export const SELECTORS = {
  dialog: '[role=dialog]',
  editor: '[data-testid=tweetTextarea_0]',
  addButton: '[data-testid=addButton]',
  fileInput: 'input[data-testid=fileInput]',
  postButton: '[data-testid=tweetButton]',
  scheduleButton: '[data-testid=scheduleOption]',
  scheduleConfirm: '[data-testid=scheduledConfirmationPrimaryAction]',
  unsentTweet: '[data-testid=unsentTweet]',
  tweetText: '[data-testid=tweetText]',
  deleteConfirm: '[data-testid=confirmationSheetConfirm]',
  attachments: '[data-testid=attachments]',
  toast: '[data-testid=toast]',
  profileLink: '[data-testid=AppTabBar_Profile_Link]',
};
export const CREATE_POST_URL = /\/i\/api\/graphql\/[^/]+\/(?:Create(?:Tweet|Post|NoteTweet)|NoteTweet)\b/;

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

function parseJSON(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function objects(value) {
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(objects)];
}

function numericId(value) {
  return (typeof value === 'string' || Number.isSafeInteger(value)) && /^\d+$/.test(String(value)) ? String(value) : null;
}

export function parseCreateScheduledResponse(body) {
  const json = parseJSON(body);
  for (const key of ['scheduled_tweet_id', 'rest_id', 'id']) {
    for (const object of objects(json?.data)) {
      const id = numericId(object[key]);
      if (id) return { id };
    }
  }
  if (Array.isArray(json?.errors) && json.errors.length) {
    return {
      message: json.errors.map(error => error?.message).filter(Boolean).join('；'),
      codes: json.errors.map(error => error?.code).filter(code => code !== undefined && code !== null),
    };
  }
  return null;
}

export function parseScheduledListInOrder(body) {
  const json = parseJSON(body);
  const observed = json?.data?.viewer?.scheduled_tweet_list;
  const candidates = Array.isArray(observed) ? observed : objects(json);
  const records = new Map();
  for (const object of candidates) {
    if (!object || typeof object !== 'object') continue;
    const id = numericId(object.rest_id) || numericId(object.id);
    if (!id) continue;
    const nested = objects(object);
    const scheduling = object.scheduling_info ?? nested.find(value => value.execute_at !== undefined);
    const rawTime = scheduling?.execute_at;
    if (!['number', 'string'].includes(typeof rawTime) || String(rawTime).trim() === '') continue;
    const time = Number(rawTime);
    const date = new Date(time < 1e12 ? time * 1000 : time);
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(date.getTime())) continue;
    const request = object.tweet_create_request;
    const text = typeof request?.status === 'string' ? request.status
      : nested.find(value => typeof value.text === 'string')?.text
        ?? nested.find(value => typeof value.status === 'string')?.status;
    if (text === undefined) continue;
    const media = new Set();
    for (const value of request && Array.isArray(request.media_ids) ? [request] : nested) {
      for (const key of ['media_ids', 'media_ids_str', 'media_entities', 'media']) {
        if (!Array.isArray(value[key])) continue;
        for (const item of value[key]) {
          const mediaId = typeof item === 'object' && item ? item.media_id ?? item.media_id_string ?? item.id_str ?? item.id : item;
          if (mediaId != null) media.add(String(mediaId));
        }
      }
    }
    records.set(id, { id, scheduled_at: date.toISOString(), text, media_count: media.size,
      state: typeof scheduling?.state === 'string' ? scheduling.state : null });
  }
  return [...records.values()];
}

export function parseScheduledList(body) {
  return parseScheduledListInOrder(body).sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
}

function normalizeWhitespace(text) { return text.trim().replace(/\s+/gu, ' '); }

export function findScheduledTarget(entries, id, domTexts) {
  const index = entries.findIndex(entry => entry.id === id);
  if (index < 0) throw new XPosterError('INVALID_INPUT', '该预排期帖不存在或已被删除。');
  const target = entries[index];
  if (entries.filter(entry => normalizeWhitespace(entry.text) === normalizeWhitespace(target.text)
    && entry.scheduled_at === target.scheduled_at).length > 1) {
    throw new XPosterError('INVALID_INPUT', '存在文字和时间相同的预排期帖，无法安全区分。', {
      hint: '请用户在 X 网页的预排期列表中手动取消。',
    });
  }
  if (domTexts !== undefined && (domTexts.length !== entries.length || typeof domTexts[index] !== 'string'
    || normalizeWhitespace(domTexts[index]) !== normalizeWhitespace(target.text))) {
    throw new XPosterError('UI_CHANGED', '预排期列表顺序或文字与服务器记录不一致，已停止取消。', { selector: SELECTORS.unsentTweet });
  }
  return index;
}

function uncertainCancellation(message = '删除可能未生效，请在 X 预排期列表中检查。') {
  return new XPosterError('UNCERTAIN', message, { hint: '绝不自动重试。请用户立即检查 X 预排期列表：https://x.com/compose/post/unsent/scheduled' });
}

export function verifyScheduledDeletion(before, after, id) {
  const remainingIds = new Set(after.map(entry => entry.id));
  const missing = before.filter(entry => entry.id !== id && !remainingIds.has(entry.id)).map(entry => entry.id);
  if (missing.length) {
    throw new XPosterError('UNCERTAIN', '警告：其他预排期帖也已消失，可能误删了不同的帖子！', {
      missing_ids: missing, hint: '请用户立即在 X 预排期列表中核查所有帖子！绝不自动重试或继续删除。',
    });
  }
  if (remainingIds.has(id)) throw uncertainCancellation();
  return { id, deleted: true, remaining: after.length };
}

export function classifyScheduleSelects(optionValues) {
  const fields = [];
  const hasRange = (values, first, last) => values.length === last - first + 1
    && Array.from({ length: last - first + 1 }, (_, i) => String(first + i)).every(value => values.includes(value));
  for (const [index, options] of optionValues.entries()) {
    const values = options.filter(value => value !== '');
    let field;
    if (values.length && values.every(value => /^\d{4}$/.test(value))) field = 'year';
    else if (hasRange(values, 0, 59)) field = 'minute';
    else if (hasRange(values, 0, 23)) field = 'hour';
    else if ([28, 29, 30, 31].some(last => hasRange(values, 1, last))) field = 'day';
    // Month and 12-hour values are identical; X places month before hour in both layouts.
    else if (hasRange(values, 1, 12)) field = fields.includes('month') ? 'hour12' : 'month';
    else if (values.length === 2 && values.every(value => !/^\d+$/.test(value))) field = 'ampm';
    if (!field || fields.includes(field)) {
      throw new XPosterError('UI_CHANGED', '无法识别预排期时间控件。', { selector: `${SELECTORS.dialog} select:nth-of-type(${index + 1})` });
    }
    fields.push(field);
  }
  const required = ['year', 'month', 'day', 'minute', fields.includes('hour12') ? 'hour12' : 'hour'];
  if (required.some(field => !fields.includes(field)) || fields.includes('hour12') !== fields.includes('ampm')
    || fields.includes('hour') && fields.includes('hour12')) {
    throw new XPosterError('UI_CHANGED', '预排期时间控件不完整。', { selector: `${SELECTORS.dialog} select` });
  }
  return fields;
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

export async function fillText(page, selector, text) {
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

export async function waitUntilReady(page, scope, images, weightedLength, editorSelector) {
  const deadline = Date.now() + (images.length ? 120000 : 15000);
  let readyPolls = 0;
  let missingSince = null;
  let disabledSince = null;
  let snapshot;
  let settled = false;
  while (true) {
    snapshot = await page.call((scope, selectors, editorSelector) => {
      const button = document.querySelector(scope + selectors.postButton);
      let container = document;
      if (editorSelector) {
        container = document.querySelector(editorSelector)?.parentElement;
        while (container && !container.querySelector(selectors.attachments)) {
          const parent = container.parentElement;
          if (!parent || [...parent.querySelectorAll('[data-testid^=tweetTextarea_]')]
            .filter(element => /^tweetTextarea_\d+$/.test(element.getAttribute('data-testid'))).length !== 1) break;
          container = parent;
        }
      }
      const attachments = [...(container?.querySelectorAll(editorSelector ? selectors.attachments : scope + selectors.attachments) ?? [])];
      return {
        button: !button ? 'missing' : button.disabled || button.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled',
        hasAttachments: attachments.length > 0,
        uploading: attachments.some(el => el.querySelector('[role=progressbar]') || /uploading|processing|上传|处理/i.test(el.innerText)),
        toast: document.querySelector(selectors.toast)?.innerText || null,
      };
    }, scope, SELECTORS, editorSelector);
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

function watchCreateResponse(page, pattern = CREATE_POST_URL, timeout = 60000) {
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
  const timer = setTimeout(() => finish(null), timeout);
  subscriptions.push(page.on('Network.responseReceived', event => {
    if (!requestId && pattern.test(event.response.url)) requestId = event.requestId;
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

function uncertainSchedule() {
  return new XPosterError('UNCERTAIN', '无法确认帖子是否已创建预排期。', {
    hint: '不要自动重试，以免重复排期。请用户检查 X 的预排期列表：https://x.com/compose/post/unsent/scheduled',
  });
}

async function submitSchedule(page, selector) {
  await page.send('Network.enable');
  const watcher = watchCreateResponse(page, /\/i\/api\/graphql\/[^/]+\/CreateScheduledTweet\b/);
  try {
    try { await page.click(selector); }
    catch (error) {
      if (error instanceof XPosterError && error.code === 'UI_CHANGED') throw error;
      throw uncertainSchedule();
    }
    const parsed = parseCreateScheduledResponse(await watcher.done);
    if (parsed?.id) return parsed.id;
    if (parsed?.codes) {
      throw new XPosterError('POST_REJECTED', `X 拒绝预排期。${parsed.message ? `提示：${parsed.message}` : ''}`, {
        x_error_codes: parsed.codes, hint: '请用户查看 Chrome 窗口中的提示。',
      });
    }
    throw uncertainSchedule();
  } finally {
    watcher.cancel();
  }
}

export async function setSchedule(page, scope, components) {
  await page.click(scope + SELECTORS.scheduleButton);
  if (!await page.waitFor(selector => !!document.querySelector(selector), [SELECTORS.scheduleConfirm], { timeout: 10000 })) {
    throw new XPosterError('UI_CHANGED', '等待预排期对话框超时。', { selector: SELECTORS.scheduleConfirm });
  }
  const readSelects = selector => {
    const dialog = [...document.querySelectorAll(selector)].at(-1);
    return [...(dialog?.querySelectorAll('select') ?? [])].map(select => ({
      value: select.value, options: [...select.options].map(option => ({ value: option.value, text: option.text })),
    }));
  };
  async function controls() {
    const selects = await page.call(readSelects, SELECTORS.dialog);
    return { selects, fields: classifyScheduleSelects(selects.map(select => select.options.map(option => option.value))) };
  }
  const initial = await controls();
  if (!initial.selects[initial.fields.indexOf('year')].options.some(option => option.value === String(components.year))) {
    throw new XPosterError('INVALID_INPUT', 'X 的预排期年份选项不包含所选年份。');
  }
  const expected = { ...components };
  if (initial.fields.includes('hour12')) {
    expected.hour12 = components.hour % 12 || 12;
    const options = initial.selects[initial.fields.indexOf('ampm')].options;
    const pattern = components.hour < 12 ? /^(am|a\.?m\.?)$|上午|午前/i : /^(pm|p\.?m\.?)$|下午|午後/i;
    const period = options.find(option => pattern.test(option.value) || pattern.test(option.text));
    if (!period) throw new XPosterError('UI_CHANGED', '无法识别上午／下午选项。', { selector: `${SELECTORS.dialog} select` });
    expected.ampm = period.value;
  }
  // Set a safe day first so changing month/year cannot silently roll the date over.
  const assignments = [['day', 1], ...['year', 'month', 'day', 'hour', 'hour12', 'minute', 'ampm']
    .filter(field => initial.fields.includes(field)).map(field => [field, expected[field]])];
  for (const [field, rawValue] of assignments) {
    const { fields } = await controls();
    const index = fields.indexOf(field);
    const value = String(rawValue);
    const set = await page.call((selector, index, value) => {
      const select = [...document.querySelectorAll(selector)].at(-1)?.querySelectorAll('select')[index];
      if (!select || ![...select.options].some(option => option.value === value)) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value === value;
    }, SELECTORS.dialog, index, value);
    if (!set) throw new XPosterError('UI_CHANGED', '无法设置预排期时间。', { selector: `${SELECTORS.dialog} select` });
  }
  const final = await controls();
  if (final.fields.some((field, index) => final.selects[index].value !== String(expected[field]))) {
    throw new XPosterError('UI_CHANGED', '预排期时间与预期不一致。', { selector: `${SELECTORS.dialog} select` });
  }
  await page.click(SELECTORS.scheduleConfirm);
  const returned = await page.waitFor((confirm, editor) => {
    const el = document.querySelector(editor);
    return !document.querySelector(confirm) && !!el && el.getBoundingClientRect().width > 0;
  }, [SELECTORS.scheduleConfirm, scope + SELECTORS.editor], { timeout: 10000 });
  if (!returned) throw new XPosterError('UI_CHANGED', '预排期确认后未返回发帖编辑器。', { selector: scope + SELECTORS.editor });
}

async function captureScheduledList(page) {
  await page.send('Network.enable');
  const watcher = watchCreateResponse(page, /FetchScheduledTweets\b/, 30000);
  try {
    await page.navigate(URLS.scheduled);
    const body = await watcher.done;
    if (body !== null) {
      const json = parseJSON(body);
      if (json?.data && !json.errors?.length) {
        const entries = parseScheduledListInOrder(body);
        const observed = json.data.viewer?.scheduled_tweet_list;
        // Never verify a deletion against a partially parsed or unrecognized list.
        if (Array.isArray(observed) ? entries.length === observed.length
          : entries.length > 0 || objects(json.data).some(value => Array.isArray(value.scheduled) && value.scheduled.length === 0)) return entries;
      }
    } else if (await page.call(() => !!document.querySelector('[data-testid=emptyState]'))) return [];
    throw new XPosterError('UI_CHANGED', '无法读取 X 的完整预排期列表。', {
      selector: '[data-testid=emptyState]', hint: '请用户在 X 网页中检查预排期列表，页面或数据结构可能发生变化。',
    });
  } finally {
    watcher.cancel();
  }
}

export async function listScheduled(browser) {
  const page = await browser.newPage();
  try {
    return (await captureScheduledList(page)).sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  } finally {
    await page.close().catch(error => console.error('关闭预排期列表标签页失败：', error));
  }
}

async function tagCancelButton(page, labels, tag) {
  const selector = `[data-x-poster-cancel="${tag}"]`;
  const tagged = await page.call((dialogSelector, labels, tag) => {
    const dialog = [...document.querySelectorAll(dialogSelector)].at(-1);
    const buttons = [...(dialog?.querySelectorAll('button, [role=button]') ?? [])]
      .filter(button => labels.includes((button.innerText || '').trim().replace(/\s+/gu, ' ')));
    if (buttons.length !== 1) return false;
    buttons[0].setAttribute('data-x-poster-cancel', tag);
    return true;
  }, SELECTORS.dialog, labels, tag);
  if (!tagged) throw new XPosterError('UI_CHANGED', '无法唯一识别预排期列表按钮。', { selector, labels });
  return selector;
}

async function scheduledDomTexts(page) {
  return page.call(selectors => {
    const dialog = [...document.querySelectorAll(selectors.dialog)].at(-1);
    return [...(dialog?.querySelectorAll(selectors.unsentTweet) ?? [])]
      .map(item => item.querySelector(selectors.tweetText)?.innerText ?? '');
  }, SELECTORS);
}

function selectionStates(selectors) {
  const dialog = [...document.querySelectorAll(selectors.dialog)].at(-1);
  return [...(dialog?.querySelectorAll(selectors.unsentTweet) ?? [])].map(item => {
    const label = item.closest('label') ?? item;
    const checkbox = label.matches('input[type=checkbox], [role=checkbox], [aria-checked]') ? label
      : label.querySelector('input[type=checkbox], [role=checkbox], [aria-checked]');
    if (!checkbox) return null;
    if (checkbox.matches('input[type=checkbox]')) return checkbox.indeterminate ? null : checkbox.checked;
    const checked = checkbox.getAttribute('aria-checked');
    return checked === 'true' ? true : checked === 'false' ? false : null;
  });
}

export async function cancelScheduled(browser, id) {
  const page = await browser.newPage();
  let deleteWatcher;
  let confirming = false;
  try {
    const before = await captureScheduledList(page);
    const index = findScheduledTarget(before, id);
    const loaded = await page.waitFor((selectors, count) => {
      const dialog = [...document.querySelectorAll(selectors.dialog)].at(-1);
      return dialog?.querySelectorAll(selectors.unsentTweet).length === count;
    }, [SELECTORS, before.length], { timeout: 10000 });
    if (!loaded) throw new XPosterError('UI_CHANGED', '预排期列表条数与服务器记录不一致。', { selector: SELECTORS.unsentTweet });
    findScheduledTarget(before, id, await scheduledDomTexts(page));
    await page.click(await tagCancelButton(page, ['编辑', 'Edit'], 'edit'));
    const editing = await page.waitFor(selector => [...document.querySelectorAll(selector)].at(-1)
      && [...[...document.querySelectorAll(selector)].at(-1).querySelectorAll('button, [role=button]')]
        .some(button => ['完成', 'Done'].includes((button.innerText || '').trim())), [SELECTORS.dialog], { timeout: 10000 });
    if (!editing) throw new XPosterError('UI_CHANGED', '未能进入预排期编辑模式。', { selector: SELECTORS.dialog });
    findScheduledTarget(before, id, await scheduledDomTexts(page));
    const initialSelection = await page.call(selectionStates, SELECTORS);
    if (initialSelection.length !== before.length || initialSelection.some(value => value === true)) {
      throw new XPosterError('UI_CHANGED', '编辑模式存在默认选中项，已停止取消。', { selector: SELECTORS.unsentTweet });
    }
    const tagged = await page.call((selectors, index, text) => {
      const dialog = [...document.querySelectorAll(selectors.dialog)].at(-1);
      const item = dialog?.querySelectorAll(selectors.unsentTweet)[index];
      if (!item || (item.querySelector(selectors.tweetText)?.innerText ?? '').trim().replace(/\s+/gu, ' ') !== text) return false;
      item.setAttribute('data-x-poster-cancel', 'target');
      return true;
    }, SELECTORS, index, normalizeWhitespace(before[index].text));
    if (!tagged) throw new XPosterError('UI_CHANGED', '待取消帖子在选择前发生变化。', { selector: SELECTORS.unsentTweet });
    await page.click('[data-x-poster-cancel="target"]');
    const selected = await page.call(selectionStates, SELECTORS);
    if (selected.length !== before.length || selected.some(value => value !== null)
      && (selected.some(value => value === null) || selected[index] !== true || selected.filter(Boolean).length !== 1)) {
      throw new XPosterError('UI_CHANGED', '无法确认仅选中了目标预排期帖，已停止删除。', { selector: SELECTORS.unsentTweet });
    }
    deleteWatcher = watchCreateResponse(page, /DeleteScheduledTweet\b/, 10000);
    await page.click(await tagCancelButton(page, ['删除', 'Delete'], 'delete'));
    if (!await page.waitFor(selector => !!document.querySelector(selector), [SELECTORS.deleteConfirm], { timeout: 10000 })) {
      throw new XPosterError('UI_CHANGED', '未出现删除确认对话框。', { selector: SELECTORS.deleteConfirm });
    }
    confirming = true;
    await page.click(SELECTORS.deleteConfirm);
    // The response is only a synchronization hint; the fresh list is the source of truth.
    await deleteWatcher.done;
    return verifyScheduledDeletion(before, await captureScheduledList(page), id);
  } catch (error) {
    if (confirming && !(error instanceof XPosterError && error.code === 'UNCERTAIN')) throw uncertainCancellation();
    throw error;
  } finally {
    deleteWatcher?.cancel();
    await page.close().catch(error => console.error('关闭取消预排期标签页失败：', error));
  }
}

export async function compose(browser, { text, images, submit, mode = submit ? 'post' : 'preview', scheduledAt, screenshotPath, weightedLength }) {
  if (!['preview', 'post', 'schedule'].includes(mode) || mode === 'schedule' && !scheduledAt || mode === 'post' && scheduledAt) {
    throw new XPosterError('INVALID_INPUT', '预排期必须使用 schedule 模式并提供时间。');
  }
  const page = await browser.newPage();
  try {
    const scope = await openComposer(page);
    if (text) await fillText(page, scope + SELECTORS.editor, text);
    if (images.length) await page.setFiles(scope + SELECTORS.fileInput, images);
    await waitUntilReady(page, scope, images, weightedLength);
    if (scheduledAt) {
      await setSchedule(page, scope, scheduledAt);
      await waitUntilReady(page, scope, images, weightedLength);
    }
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
    if (mode === 'preview') return { screenshot, username };
    const id = mode === 'schedule' ? await submitSchedule(page, scope + SELECTORS.postButton)
      : await submitPost(page, scope + SELECTORS.postButton);
    return { screenshot, username, id };
  } finally {
    // Cleanup failures must not turn a confirmed post into a retryable failure.
    await page.close().catch(error => console.error('关闭发帖标签页失败：', error));
  }
}

export async function openComposer(page, url = URLS.compose) {
  await page.navigate(url);
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
  return scope;
}
