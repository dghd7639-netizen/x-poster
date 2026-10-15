import { writeFile } from 'node:fs/promises';
import { XPosterError } from './errors.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ARTICLES_URL = 'https://x.com/compose/articles';
const editURL = id => `${ARTICLES_URL}/edit/${id}`;
export const ARTICLE_SELECTORS = {
  create: 'button[aria-label="create"]',
  composer: '[data-testid=composer]',
  dialog: '[role=dialog]',
  menuItem: '[role=menu] [role=menuitem]',
  insert: '[aria-label="添加媒体内容"], [aria-label="Add media content"]',
  fileInput: 'input[data-testid=fileInput]',
  mediaInput: '[role=dialog] input[data-testid=fileInput]',
  cover: '[aria-label="添加照片或视频"], [aria-label="Add photos or video"]',
  removeMedia: '[aria-label="移除媒体"], [aria-label="Remove media"]',
  confirm: '[data-testid=confirmationSheetConfirm]',
  profileLink: '[data-testid=AppTabBar_Profile_Link]',
};

function uncertain(id, message = '无法确认文章操作是否完成。') {
  return new XPosterError('UNCERTAIN', message, {
    article_id: id, edit_url: editURL(id),
    hint: `不要自动重试。请检查 ${editURL(id)} 及 ${ARTICLES_URL} 的草稿或“已发布”标签。`,
  });
}

function requestArticleId(record) {
  return String(record.variables?.articleEntityId ?? record.variables?.article_id
    ?? record.variables?.articleId ?? record.variables?.rest_id ?? '');
}

function watchRequests(page) {
  const requests = new Map();
  let sequence = 0;
  let lastUpdateAt = Date.now();
  let stopped = false;
  const off = [];
  off.push(page.on('Network.requestWillBeSent', ({ requestId, request }) => {
    const operation = request.url.match(/^https:\/\/x\.com\/i\/api\/graphql\/[^/]+\/(Article\w+)\b/)?.[1];
    if (!operation || request.method !== 'POST' && !(request.method === 'GET' && operation === 'ArticleEntityResultByRestId')) return;
    let variables;
    try { variables = JSON.parse(request.postData).variables; } catch { /* GET requests carry variables in the URL. */ }
    if (!variables) {
      try { variables = JSON.parse(new URL(request.url).searchParams.get('variables')); } catch { /* Uncorrelated requests cannot prove an article's state. */ }
    }
    const record = { requestId, operation, variables, sequence: ++sequence, done: false, ok: false };
    requests.set(requestId, record);
    if (/^ArticleEntityUpdate/.test(operation)) lastUpdateAt = Date.now();
  }));
  off.push(page.on('Network.responseReceived', ({ requestId, response }) => {
    const record = requests.get(requestId);
    if (record) record.status = response.status;
  }));
  off.push(page.on('Network.loadingFinished', ({ requestId }) => {
    const record = requests.get(requestId);
    if (!record) return;
    page.send('Network.getResponseBody', { requestId }).then(result => {
      if (stopped) return;
      try {
        record.body = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
        record.ok = record.status === 200 && record.body && typeof record.body === 'object'
          && (!record.body.errors || Array.isArray(record.body.errors) && record.body.errors.length === 0)
          && !!record.body.data;
      } catch { record.ok = false; }
      record.done = true;
    }, () => { record.done = true; });
  }));
  off.push(page.on('Network.loadingFailed', ({ requestId }) => {
    const record = requests.get(requestId);
    if (record) record.done = true;
  }));
  return {
    mark: () => sequence,
    updates: after => [...requests.values()].filter(record => record.sequence > after && /^ArticleEntityUpdate/.test(record.operation)),
    lastUpdateAt: () => lastUpdateAt,
    mutation: (pattern, id, after = 0) => [...requests.values()].find(record => record.sequence > after && pattern.test(record.operation)
      && requestArticleId(record) === id && record.done),
    missingArticle: id => [...requests.values()].some(record => {
      if (record.operation !== 'ArticleEntityResultByRestId' || requestArticleId(record) !== id || !record.done || !record.ok) return false;
      const result = record.body.data.article_result_by_rest_id?.result;
      return result == null || typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0;
    }),
    stop() { stopped = true; off.forEach(unsubscribe => unsubscribe()); },
  };
}

async function waitEditor(page, watcher, id, operation) {
  const existingDraft = operation === 'cover';
  const deadline = Date.now() + 30000;
  let ready;
  let route;
  let routeSince;
  do {
    ready = await page.waitFor((selectors, expectedId) => {
      if (/\/i\/flow\/login/.test(location.pathname)) return 'login';
      if (/\/account\/access/.test(location.pathname)) return 'challenge';
      const title = [...document.querySelectorAll('textarea')].find(el => /标题|title/i.test(el.placeholder));
      if (location.pathname !== `/compose/articles/edit/${expectedId}`) return location.pathname;
      const composer = document.querySelector(selectors.composer);
      if (title && composer) return 'ready';
      // The left article list also says "Published"; require the reader's Unpublish control.
      const reader = document.querySelector('main, [role=main]');
      if (!title && !composer && reader && [...reader.querySelectorAll('button, [role=button], [role=menuitem]')]
        .some(el => !el.closest(selectors.dialog) && /^(取消发布(?:[，,、].*)?|Unpublish\b.*)$/i
          .test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()))) return 'published';
      return 'loading';
    }, [ARTICLE_SELECTORS, id], { timeout: Math.max(0, deadline - Date.now()) });
    if (ready === 'login' || ready === 'challenge' || ready === 'published') break;
    if (watcher.missingArticle(id)) { ready = 'missing'; break; }
    if (ready === 'loading') route = null;
    else {
      if (!ready?.startsWith('/')) break;
      // Client-side routing may briefly visit the article list before opening the editor.
      if (ready !== route) { route = ready; routeSince = Date.now(); }
      if (Date.now() - routeSince >= 2000) { ready = 'redirected'; break; }
    }
    if (Date.now() >= deadline) break;
    await delay(250);
  } while (true);
  if (ready === 'login') throw new XPosterError('NOT_LOGGED_IN', 'X 登录已过期，请调用 x_login 让用户自行登录。');
  if (ready === 'challenge') throw new XPosterError('ACCOUNT_CHALLENGE', 'X 要求验证，请让用户在普通登录窗口中自行处理。');
  if (ready === 'missing') throw new XPosterError('INVALID_INPUT', '文章草稿不存在或无法打开。', { article_id: id, edit_url: editURL(id) });
  if (ready === 'published') {
    const message = existingDraft ? '该文章已发布，x_article_cover 只能用于草稿。如需更换已发布文章的封面，请让用户在 X 网页上操作。'
      : operation === 'delete' ? '该文章已发布，x_article_delete 只删除草稿。' : '该文章已发布。';
    throw new XPosterError('INVALID_INPUT', message, { article_id: id, edit_url: editURL(id) });
  }
  if (existingDraft && (ready === 'redirected' || await page.call(() => location.pathname) !== `/compose/articles/edit/${id}`)) {
    throw new XPosterError('INVALID_INPUT', '文章草稿不存在或无法打开。');
  }
  if (ready !== 'ready') throw new XPosterError('UI_CHANGED', '文章编辑器未加载或文章 id 不匹配。', { edit_url: editURL(id) });
}

// Tag exact text matches, then use Page.click for trusted input and obstruction checks.
async function findAction(page, kind) {
  return page.call((selectors, kind) => {
    const matches = (el, pattern) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && pattern.test((el.innerText || el.textContent || '').trim());
    let element;
    const buttons = [...document.querySelectorAll('button')];
    if (kind === 'publish') element = buttons.find(el => !el.closest(selectors.dialog) && matches(el, /^(发布|Publish)$/i));
    if (kind === 'more') {
      // Publish is disabled for incomplete drafts; it is only a position anchor here.
      const index = buttons.findIndex(el => !el.closest(selectors.dialog) && /^(发布|Publish)$/i.test((el.innerText || '').trim()));
      if (index >= 0) element = buttons.slice(index + 1).find(el => /^(更多|More)$/i.test(el.getAttribute('aria-label') || '') && !el.closest(selectors.dialog));
    }
    if (kind === 'media' || kind === 'delete') element = [...document.querySelectorAll(selectors.menuItem)]
      .find(el => matches(el, kind === 'media' ? /^(媒体|Media)$/i : /^(删除文章|Delete article)$/i));
    if (kind === 'apply' || kind === 'confirmPublish') {
      element = kind === 'confirmPublish' ? document.querySelector(selectors.confirm) : null;
      element ??= [...document.querySelectorAll(selectors.dialog)].flatMap(el => [...el.querySelectorAll('button')])
        .find(el => matches(el, kind === 'apply' ? /^(应用|Apply)$/i : /^(发布|Publish)$/i));
    }
    if (!element) return null;
    element.setAttribute('data-x-poster-article', kind);
    return `[data-x-poster-article="${kind}"]`;
  }, ARTICLE_SELECTORS, kind);
}

// Menus and dialogs animate in, so a fresh button can briefly sit under another layer; retry for a moment.
async function clickWhenReady(page, selector) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try { return await page.click(selector); }
    catch (error) {
      if (!(error instanceof XPosterError && error.code === 'UI_CHANGED' && /遮挡/.test(error.message)) || Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

// Menus animate open and may re-render their items, so re-find the target each round and click
// only once its position has settled.
async function clickAction(page, kind) {
  const deadline = Date.now() + 5000;
  let lastRect = null;
  let lastError = null;
  for (;;) {
    const selector = await findAction(page, kind);
    const rect = selector ? await page.call(sel => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') : null;
    }, selector) : null;
    if (rect && rect === lastRect) {
      try { return await page.click(selector); }
      catch (error) {
        if (!(error instanceof XPosterError && error.code === 'UI_CHANGED')) throw error;
        lastError = error;
      }
    }
    lastRect = rect;
    if (Date.now() >= deadline) {
      throw lastError ?? new XPosterError('UI_CHANGED', '找不到文章操作按钮。', { action: kind });
    }
    await delay(150);
  }
}

function snapshot(selectors) {
  const title = [...document.querySelectorAll('textarea')].find(el => /标题|title/i.test(el.placeholder))?.value ?? '';
  const composer = document.querySelector(selectors.composer);
  const images = composer ? Math.max(composer.querySelectorAll('img').length, composer.querySelectorAll(selectors.removeMedia).length) : 0;
  const bodyText = document.body.innerText || '';
  // X keeps the change-cover button after upload; the media can be its sibling.
  const anchors = [...document.querySelectorAll(selectors.cover), ...document.querySelectorAll(selectors.fileInput)]
    .filter(el => !el.closest(selectors.dialog) && !el.closest(selectors.composer));
  const coverMedia = [];
  const cover = anchors.some(anchor => {
    for (let area = anchor; area && !area.contains(composer) && !area.querySelector('textarea'); area = area.parentElement) {
      const media = [...area.querySelectorAll('img, video')].filter(el => {
        const src = el.currentSrc || el.src || '';
        if (el.closest(selectors.dialog) || el.closest(selectors.composer) || el.closest(selectors.cover)
          || el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]')
          || /profile_images|\/emoji\//i.test(src)) return false;
        return el.getBoundingClientRect().width >= 200
          || el.tagName === 'IMG' && el.complete && el.naturalWidth >= 200;
      });
      if (media.length) { coverMedia.push(...media); return true; }
    }
    return false;
  });
  const coverImages = coverMedia.filter(el => el.tagName === 'IMG');
  const coverImage = coverImages.find(el => el.getBoundingClientRect().width > 300) ?? coverImages[0];
  return {
    title, text: composer?.innerText || composer?.textContent || '', images,
    saved: bodyText.match(/(?:上一次保存|Last saved)[^\n]*/i)?.[0] ?? null,
    wordCount: bodyText.match(/\b[\d,]+\s*(?:个字|字|words?)\b/i)?.[0]
      ?? bodyText.match(/[\d,]+\s*(?:个字|字)/)?.[0] ?? null,
    cover,
    coverLoaded: !!coverImage?.complete && coverImage.naturalWidth > 0,
  };
}

async function waitCoverImage(page) {
  const deadline = Date.now() + 20000;
  for (;;) {
    if ((await page.call(snapshot, ARTICLE_SELECTORS)).coverLoaded) return undefined;
    if (Date.now() >= deadline) return '封面已保存，但图片加载超时，截图可能尚未显示封面。';
    await delay(250);
  }
}

async function insertImages(page, paths) {
  const before = (await page.call(snapshot, ARTICLE_SELECTORS)).images;
  await clickWhenReady(page, ARTICLE_SELECTORS.insert);
  if (!await page.waitFor(selectors => !!document.querySelector(selectors.menuItem), [ARTICLE_SELECTORS], { timeout: 10000 })) {
    throw new XPosterError('UI_CHANGED', '文章插入菜单未打开。');
  }
  await clickAction(page, 'media');
  if (!await page.waitFor(selector => !!document.querySelector(selector), [ARTICLE_SELECTORS.mediaInput], { timeout: 10000 })) {
    throw new XPosterError('UI_CHANGED', '文章媒体上传窗口未打开。');
  }
  await page.setFiles(ARTICLE_SELECTORS.mediaInput, paths);
  const complete = await page.waitFor((selectors, expected) => {
    const composer = document.querySelector(selectors.composer);
    const count = composer ? Math.max(composer.querySelectorAll('img').length, composer.querySelectorAll(selectors.removeMedia).length) : 0;
    return !document.querySelector(selectors.dialog) && count >= expected;
  }, [ARTICLE_SELECTORS, before + paths.length], { timeout: 120000 });
  if (!complete) {
    const detail = await page.call(selector => document.querySelector(selector)?.innerText || '', ARTICLE_SELECTORS.dialog);
    throw new XPosterError('UPLOAD_FAILED', `文章图片上传未完成。${detail ? `提示：${detail}` : ''}`);
  }
  await waitMediaProcessed(page);
}

async function waitMediaProcessed(page) {
  // X keeps the editor behind an overlay ("正在处理媒体… 取消上传") until the media finishes processing.
  const processed = await page.waitFor(() => {
    const text = document.body.innerText || '';
    const cancel = [...document.querySelectorAll('button')].some(el => /^(取消上传|Cancel upload)$/i.test((el.innerText || '').trim()));
    return !cancel && !/正在处理媒体|Processing media/i.test(text);
  }, [], { timeout: 120000 });
  if (!processed) throw new XPosterError('UPLOAD_FAILED', '文章媒体在 X 端处理超时（正在处理媒体）。');
}

async function chooseCoverFile(page, path) {
  let chooser;
  const off = page.on('Page.fileChooserOpened', event => { chooser = event; });
  try {
    await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await clickWhenReady(page, ARTICLE_SELECTORS.cover);
    const deadline = Date.now() + 10000;
    while (!chooser && Date.now() < deadline) await delay(100);
    if (!chooser?.backendNodeId) throw new XPosterError('UPLOAD_FAILED', '文章封面文件选择器未打开。');
    await page.send('DOM.enable');
    await page.send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [path] });
  } finally {
    off();
    await page.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

async function insertCover(page, path, hadCover = false) {
  const selector = await page.call(selectors => {
    const input = [...document.querySelectorAll(selectors.fileInput)].find(el => !el.closest(selectors.dialog) && !el.closest(selectors.composer));
    if (!input) return null;
    input.setAttribute('data-x-poster-article', 'coverInput');
    return '[data-x-poster-article="coverInput"]';
  }, ARTICLE_SELECTORS);
  if (selector) await page.setFiles(selector, [path]);
  else if (hadCover) await chooseCoverFile(page, path);
  else throw new XPosterError('UI_CHANGED', '找不到文章封面上传控件。');
  if (!await page.waitFor(selector => !!document.querySelector(selector), [ARTICLE_SELECTORS.dialog], { timeout: 120000 })) {
    throw new XPosterError('UPLOAD_FAILED', '文章封面裁剪窗口未出现。');
  }
  await clickAction(page, 'apply');
  if (!await page.waitFor(selector => !document.querySelector(selector), [ARTICLE_SELECTORS.dialog], { timeout: 120000 })) {
    throw new XPosterError('UPLOAD_FAILED', '文章封面裁剪未完成，请检查“应用”按钮。');
  }
  await waitMediaProcessed(page);
}

async function waitSaved(page, watcher, mark, savedBefore, lastEdit, id) {
  const deadline = Date.now() + 60000;
  do {
    const current = await page.call(snapshot, ARTICLE_SELECTORS);
    const updates = watcher.updates(mark);
    const quiet = Date.now() - Math.max(lastEdit, watcher.lastUpdateAt()) >= 3000;
    const settled = watcher.updates(0).every(record => record.done && record.ok);
    const contentSaved = updates.some(record => record.operation === 'ArticleEntityUpdateContent' && record.ok);
    const indicatorChanged = current.saved && current.saved !== savedBefore;
    if (quiet && settled && (contentSaved || indicatorChanged)) return current;
    if (Date.now() >= deadline) break;
    await delay(250);
  } while (true);
  throw uncertain(id, '无法确认文章已完整自动保存，草稿可能不完整。');
}

export async function createArticleDraft(browser, { title, segments, cover, screenshotPath }) {
  const page = await browser.newPage();
  const watcher = watchRequests(page);
  let articleId;
  try {
    await page.send('Network.enable');
    await page.navigate(ARTICLES_URL);
    if (!await page.waitFor(selector => !!document.querySelector(selector), [ARTICLE_SELECTORS.create], { timeout: 30000 })) {
      throw new XPosterError('ARTICLES_UNAVAILABLE', 'X Articles 需要符合资格的 Premium 账号，当前账号无法新建文章。');
    }
    await page.click(ARTICLE_SELECTORS.create);
    articleId = await page.waitFor(() => location.pathname.match(/^\/compose\/articles\/edit\/(\d+)$/)?.[1]);
    if (!articleId) throw new XPosterError('UNCERTAIN', '无法确认新文章草稿的 id。', { hint: `不要自动重试，请检查 ${ARTICLES_URL} 的草稿。` });
    await waitEditor(page, watcher, articleId);
    await page.call(() => {
      const title = [...document.querySelectorAll('textarea')].find(el => /标题|title/i.test(el.placeholder));
      title.focus();
    });
    await page.insertText(title);
    let mark;
    let savedBefore;
    let lastEdit;
    for (const segment of segments) {
      await page.press('Escape');
      await page.call(selector => document.querySelector(selector).focus(), ARTICLE_SELECTORS.composer);
      await page.press('DocumentEnd');
      savedBefore = (await page.call(snapshot, ARTICLE_SELECTORS)).saved;
      mark = watcher.mark();
      lastEdit = Date.now();
      if (segment.type === 'images') await insertImages(page, segment.paths);
      else {
        const before = (await page.call(snapshot, ARTICLE_SELECTORS)).text;
        await page.call((selector, html, text) => {
          const composer = document.querySelector(selector);
          const data = new DataTransfer();
          data.setData('text/html', html); data.setData('text/plain', text);
          composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, ARTICLE_SELECTORS.composer, segment.html, segment.text);
        if (!await page.waitFor((selectors, before) => {
          const composer = document.querySelector(selectors.composer);
          return (composer?.innerText || composer?.textContent || '') !== before;
        }, [ARTICLE_SELECTORS, before], { timeout: 5000 })) throw uncertain(articleId, '文章编辑器没有接受正文，草稿可能不完整。');
      }
    }
    await page.press('Escape');
    if (cover) {
      lastEdit = Date.now();
      const coverMark = watcher.mark();
      await insertCover(page, cover);
      const response = await waitMutation(watcher, /^ArticleEntityUpdateCoverMedia$/, articleId, 60000, coverMark);
      if (!response?.ok) throw uncertain(articleId, '无法确认文章封面已保存，请检查草稿。');
    }
    let final = await waitSaved(page, watcher, mark, savedBefore, lastEdit, articleId);
    const expected = segments.reduce((sum, segment) => sum + (segment.paths?.length ?? 0), 0);
    await page.call(selector => { window.scrollTo(0, 0); document.querySelector(selector)?.scrollIntoView({ block: 'start' }); }, 'textarea');
    const warning = cover ? await waitCoverImage(page) : undefined;
    if (cover) final = await page.call(snapshot, ARTICLE_SELECTORS);
    if (final.title !== title || !final.text.trim() && !final.images || final.images !== expected || !!cover && !final.cover) {
      throw uncertain(articleId, '文章标题、正文、图片数量或封面与预期不一致，请检查草稿。');
    }
    const screenshot = await page.screenshot();
    await writeFile(screenshotPath, screenshot, { mode: 0o600 });
    return { article_id: articleId, edit_url: editURL(articleId), title, images_inserted: final.images,
      images_expected: expected, cover: final.cover, word_count_text: final.wordCount, screenshot, ...(warning ? { warning } : {}) };
  } catch (error) {
    if (articleId) {
      if (!(error instanceof XPosterError)) throw uncertain(articleId, '已创建文章草稿，但后续操作未完成，请检查草稿。');
      error.details = { article_id: articleId, edit_url: editURL(articleId), ...error.details };
    }
    throw error;
  } finally {
    watcher.stop();
    await page.close().catch(() => {});
  }
}

export async function setArticleCover(browser, articleId, { cover, screenshotPath }) {
  const page = await browser.newPage();
  const watcher = watchRequests(page);
  let attempted = false;
  try {
    await page.send('Network.enable');
    await page.navigate(editURL(articleId));
    await waitEditor(page, watcher, articleId, 'cover');
    const replaced = (await page.call(snapshot, ARTICLE_SELECTORS)).cover;
    const mark = watcher.mark();
    attempted = true;
    await insertCover(page, cover, replaced);
    const response = await waitMutation(watcher, /^ArticleEntityUpdateCoverMedia$/, articleId, 60000, mark);
    // GraphQL errors also leave the save unconfirmed: report UNCERTAIN, never retry automatically.
    if (!response?.ok) throw uncertain(articleId, '无法确认文章封面已保存。');
    let warning;
    let screenshot = null;
    try {
      await page.call(() => window.scrollTo(0, 0));
      warning = await waitCoverImage(page);
      const image = await page.screenshot();
      await writeFile(screenshotPath, image, { mode: 0o600 });
      screenshot = image;
    } catch {
      warning = '封面已保存，但截图失败，请打开草稿查看封面。';
    }
    return { article_id: articleId, edit_url: editURL(articleId), replaced, cover: true, screenshot, ...(warning ? { warning } : {}) };
  } catch (error) {
    if (attempted && !(error instanceof XPosterError)) throw uncertain(articleId, '文章封面操作未完成，请检查草稿。');
    if (error instanceof XPosterError) error.details = { article_id: articleId, edit_url: editURL(articleId), ...error.details };
    throw error;
  } finally { watcher.stop(); await page.close().catch(() => {}); }
}

async function waitMutation(watcher, pattern, id, timeout = 60000, after = 0) {
  const deadline = Date.now() + timeout;
  do {
    const record = watcher.mutation(pattern, id, after);
    if (record) return record;
    if (Date.now() >= deadline) return null;
    await delay(250);
  } while (true);
}

function publishedResult(body) {
  const ids = new Set();
  const urls = new Set();
  function walk(value, articleScope = false) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (/^(user|author|creator)/i.test(key)) continue;
      if (typeof nested === 'string') {
        const url = nested.match(/^https:\/\/x\.com\/([\w]+)\/article\/(\d+)$/);
        if (url) { urls.add(nested); ids.add(url[2]); }
        if ((/^(article_id|articleId|articleEntityId|article_entity_id)$/.test(key)
          || articleScope && /^(rest_id|id)$/.test(key)) && /^\d+$/.test(nested)) ids.add(nested);
      } else walk(nested, articleScope || /article/i.test(key));
    }
  }
  walk(body.data);
  if (ids.size !== 1 || urls.size > 1) return null;
  return { article_id: [...ids][0], ...(urls.size ? { url: [...urls][0] } : {}) };
}

export async function publishArticle(browser, articleId) {
  const page = await browser.newPage();
  const watcher = watchRequests(page);
  let attempted = false;
  try {
    await page.send('Network.enable');
    await page.navigate(editURL(articleId));
    await waitEditor(page, watcher, articleId, 'publish');
    if (!(await page.call(snapshot, ARTICLE_SELECTORS)).title.trim()) {
      throw new XPosterError('INVALID_INPUT', '文章标题不能为空。');
    }
    await page.press('Escape');
    attempted = true;
    await clickAction(page, 'publish');
    // A response may arrive immediately, or X may first render a confirmation dialog.
    const deadline = Date.now() + 10000;
    do {
      if (watcher.mutation(/^Article\w*Publish\b/, articleId)) break;
      const confirm = await findAction(page, 'confirmPublish');
      if (confirm) { await page.click(confirm); break; }
      if (Date.now() >= deadline) break;
      await delay(250);
    } while (true);
    const response = await waitMutation(watcher, /^Article\w*Publish\b/, articleId);
    const result = response?.ok ? publishedResult(response.body) : null;
    if (!result) throw uncertain(articleId, '无法确认文章是否已经发布。');
    if (!result.url) {
      const username = await page.call(selector => document.querySelector(selector)?.getAttribute('href')?.match(/^\/([\w]+)\/?$/)?.[1], ARTICLE_SELECTORS.profileLink).catch(() => null);
      if (username) result.url = `https://x.com/${username}/article/${result.article_id}`;
    }
    return result;
  } catch (error) {
    if (attempted && error.code !== 'UNCERTAIN') throw uncertain(articleId, '发布操作已尝试，但结果无法确认。');
    throw error;
  } finally { watcher.stop(); await page.close().catch(() => {}); }
}

export async function deleteArticleDraft(browser, articleId) {
  const page = await browser.newPage();
  const watcher = watchRequests(page);
  let attempted = false;
  try {
    await page.send('Network.enable');
    await page.navigate(editURL(articleId));
    await waitEditor(page, watcher, articleId, 'delete');
    await page.press('Escape');
    await clickAction(page, 'more');
    if (!await page.waitFor(selector => !!document.querySelector(selector), [ARTICLE_SELECTORS.menuItem], { timeout: 10000 })) {
      throw new XPosterError('UI_CHANGED', '文章操作菜单未打开。');
    }
    await clickAction(page, 'delete');
    if (!await page.waitFor(selector => !!document.querySelector(selector), [ARTICLE_SELECTORS.confirm], { timeout: 10000 })) {
      throw new XPosterError('UI_CHANGED', '文章删除确认窗口未出现。');
    }
    attempted = true;
    await clickWhenReady(page, ARTICLE_SELECTORS.confirm);
    const response = await waitMutation(watcher, /^ArticleEntityDelete\b/, articleId);
    if (!response?.ok || !Object.values(response.body.data).some(Boolean)) throw uncertain(articleId, '无法确认文章草稿已删除。');
    await page.navigate(ARTICLES_URL);
    if (!await page.waitFor(selector => location.pathname === '/compose/articles' && !!document.querySelector(selector), [ARTICLE_SELECTORS.create])) {
      throw uncertain(articleId, '删除后的文章列表未加载。');
    }
    if (!await page.waitFor(id => !document.querySelector(`a[href$="/edit/${id}"]`), [articleId], { timeout: 10000 })) {
      throw uncertain(articleId, '删除后的列表中仍有此文章草稿。');
    }
    return { article_id: articleId, deleted: true };
  } catch (error) {
    if (attempted && error.code !== 'UNCERTAIN') throw uncertain(articleId, '删除操作已尝试，但核验失败。');
    throw error;
  } finally { watcher.stop(); await page.close().catch(() => {}); }
}
