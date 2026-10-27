import nodeTest from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createArticleDraft, setArticleCover, publishArticle, deleteArticleDraft, ARTICLE_SELECTORS as S } from '../server/article.mjs';
import { Browser } from '../server/chrome.mjs';
import { holdsLock } from '../server/lock.mjs';
import { XPosterError } from '../server/errors.mjs';
import { config } from '../server/config.mjs';
import { articleDraft, articleCover, articlePublish, articleDelete, callTool, pendingWork, exclusive } from '../server/tools.mjs';
import { readHistory, checkRateLimit } from '../server/limits.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);

function fixture(options = {}) {
  const state = { pathname: '/compose/articles', title: '', text: '', images: 0, cover: false, dialog: null,
    menu: false, saved: '上一次保存 初始', create: true, imagePolls: 0, rectReads: {},
    processingText: '', cancelUpload: false, processingIndex: 0, mediaOpens: 0, mediaFrames: 0, textBlocks: 0, statsReads: 0, ...options };
  const calls = [];
  const handlers = new Map();
  const bodies = new Map();
  const tagged = new Map();
  let requestNumber = 0;
  const emit = (method, value) => { for (const fn of handlers.get(method) ?? []) fn(value); };
  const response = (operation, body = { data: { ok: true } }, variables = { articleEntityId: '123' }, status = 200, method = 'POST') => {
    const requestId = String(++requestNumber);
    const query = method === 'GET' ? `?${new URLSearchParams({ variables: JSON.stringify(variables) })}` : '';
    const url = `https://x.com/i/api/graphql/hash/${operation}${query}`;
    emit('Network.requestWillBeSent', { requestId, request: { url, method,
      ...(method === 'POST' ? { postData: JSON.stringify({ variables }) } : {}) } });
    bodies.set(requestId, body);
    emit('Network.responseReceived', { requestId, response: { url, status } });
    emit('Network.loadingFinished', { requestId });
  };
  const lookupArticle = () => {
    const lookup = state.articleLookup;
    if (!lookup) return;
    const receive = () => {
      calls.push(['articleResponse', Date.now()]);
      response('ArticleEntityResultByRestId', lookup.body, lookup.variables, lookup.status ?? 200, lookup.method ?? 'GET');
    };
    if (lookup.delay) setTimeout(receive, lookup.delay);
    else receive();
  };
  const element = (kind, text = '', attrs = {}) => ({ kind, innerText: text, textContent: text, disabled: false,
    value: '', placeholder: '', getAttribute: name => attrs[name] ?? null,
    setAttribute(name, value) { tagged.set(`[${name}="${value}"]`, this); },
    focus() { state.focus = kind; }, closest(selector) { return kind === 'coverInput' && selector === S.dialog ? null : null; },
    contains(other) { return other === this; }, scrollIntoView() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() {
      const index = state.rectReads[kind] ?? 0;
      state.rectReads[kind] = index + 1;
      const positions = state.rects?.[kind] ?? [0];
      const x = positions[Math.min(index, positions.length - 1)];
      calls.push(['rect', kind, x, Date.now()]);
      return { x, y: 0, width: 10, height: 10 };
    },
  });
  const title = element('title'); title.placeholder = '添加标题';
  Object.defineProperty(title, 'value', { get: () => state.title });
  const composer = element('composer');
  Object.defineProperty(composer, 'innerText', { get: () => state.text + (state.innerTextNoise ?? '') });
  Object.defineProperty(composer, 'textContent', { get: () => state.text });
  composer.querySelectorAll = selector => {
    if (selector === '[data-text=true]') return state.text.split('\n').map(textContent => ({ textContent }));
    if (selector === '[data-block=true]') {
      return Array(state.images + state.textBlocks + (state.unstableBlocks ? ++state.statsReads : 0)).fill({});
    }
    return Array(selector === 'img' || selector === S.removeMedia ? state.images : 0).fill({});
  };
  composer.dispatchEvent = event => {
    const text = event.clipboardData.values['text/plain'];
    calls.push(['paste', text, Date.now()]);
    if (state.dropPastes > 0) { state.dropPastes--; state.innerTextNoise = `${state.innerTextNoise ?? ''}界面变化`; }
    else if (!state.ignorePaste) { state.text += text.slice(0, state.pasteLimit); state.textBlocks++; }
    if (!state.noSave) response('ArticleEntityUpdateContent', state.saveError ? { errors: [{ message: 'denied' }] } : { data: { ok: true } });
    if (state.indicatorSave) state.saved = `上一次保存 ${requestNumber + state.text.length}`;
  };
  const publish = element('publish', state.english ? 'Publish' : '发布');
  publish.disabled = !!state.publishDisabled;
  const more = element('more', '', { 'aria-label': '更多' });
  const sidebarMore = element('sidebarMore', '', { 'aria-label': '更多' });
  let media = element('media', state.english ? 'Media' : '媒体');
  const remove = element('delete', state.english ? 'Delete article' : '删除文章');
  const apply = element('apply', state.english ? 'Apply' : '应用');
  const confirm = element('confirm', state.english ? 'Publish' : '发布');
  const dialog = element('dialog');
  dialog.querySelectorAll = selector => selector === 'button' ? [state.dialog === 'crop' ? apply : confirm] : [];
  Object.defineProperty(dialog, 'innerText', { get: () => state.uploadError ?? '插入' });
  const coverInput = element('coverInput');
  const coverButton = element('coverButton');
  const coverArea = element('coverArea');
  const coverMedia = element('coverMedia');
  coverMedia.tagName = state.coverTagName ?? 'IMG';
  Object.defineProperties(coverMedia, {
    complete: { get: () => state.coverComplete ?? Date.now() >= (state.coverReadyAt ?? 0) },
    naturalWidth: { get: () => state.coverNaturalWidth ?? 1200 },
  });
  coverMedia.getBoundingClientRect = () => ({ width: state.coverWidth ?? 1200 });
  coverMedia.getAttribute = name => name === 'aria-hidden' ? state.coverAriaHidden ?? null : null;
  Object.defineProperty(coverMedia, 'src', { get: () => state.coverSrc ?? 'https://pbs.twimg.com/media/cover.jpg' });
  const extraCoverImages = (state.extraCoverImages ?? []).map(scope => ({
    tagName: 'IMG', complete: true, naturalWidth: scope === 'thumbnail' ? 32 : 1200,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: scope === 'thumbnail' ? 32 : 1200 }),
    closest: selector => scope === 'body' && selector === S.composer ? composer
      : scope === 'dialog' && selector === S.dialog ? dialog : null,
  }));
  coverMedia.closest = selector => state.mediaInBody && selector === S.composer ? composer
    : state.mediaInDialog && selector === S.dialog ? dialog
      : state.mediaInCoverButton && selector === S.cover ? coverButton
        : state.coverHiddenAncestor && selector === '[aria-hidden="true"]' ? coverArea : null;
  coverArea.querySelectorAll = selector => selector === 'img, video' ? [...extraCoverImages, ...(state.cover ? [coverMedia] : [])] : [];
  const editorArea = element('editorArea');
  editorArea.contains = other => other === composer;
  editorArea.querySelectorAll = () => [element('avatar')];
  coverArea.parentElement = editorArea;
  coverInput.parentElement = coverButton.parentElement = coverArea;
  // The cover is a sibling of the persistent change-cover button.
  const cancelUpload = element('cancelUpload', state.english ? 'Cancel upload' : '取消上传');
  const reader = element('reader');
  const unpublish = element('unpublish', state.english ? 'Unpublish' : '取消发布，移至草稿');
  reader.querySelectorAll = () => state.published ? [unpublish] : [];
  Object.defineProperty(reader, 'innerText', { get: () => state.published
    ? state.english ? 'Published\nUnpublish' : '已发布\n取消发布，移至草稿' : state.text });
  const document = {
    querySelector(selector) {
      if (tagged.has(selector)) return tagged.get(selector);
      if (selector === S.menuItem) return state.menu ? media : null;
      if (selector === S.create) return state.create ? element('create') : null;
      if (selector === S.composer) return state.pathname.includes('/edit/') && !state.published && !state.editorMissing ? composer : null;
      if (selector === 'main, [role=main]') return reader;
      if (selector === S.dialog) return state.dialog ? dialog : null;
      if (selector === S.confirm) return state.dialog === 'delete' || state.sheetConfirm && state.dialog === 'publish' ? confirm : null;
      if (selector === S.mediaInput) {
        const ready = !state.mediaInputMode || state.mediaInputMode === 'frame' && state.mediaFrames > 0 && Date.now() >= state.mediaReadyAt
          || state.mediaInputMode === 'reopen' && state.mediaOpens >= 2;
        return state.dialog === 'media' && ready ? element('mediaInput') : null;
      }
      if (selector === '[role=dialog] [data-testid=app-bar-close]') return state.dialog === 'media' && state.mediaCloseButton ? element('mediaClose') : null;
      if (selector === S.insert) return element('insert');
      if (selector === S.cover) return coverButton;
      if (selector === S.profileLink) return { getAttribute: () => '/alice' };
      if (selector === `[href$="/edit/123"]` || selector.includes('a[href$=')) return state.remains ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'textarea') return state.published || state.editorMissing ? [] : [title];
      if (selector === 'button') return [sidebarMore, publish, more, ...(state.leftPublished ? [unpublish] : []), ...(state.cancelUpload ? [cancelUpload] : [])];
      if (selector === S.menuItem) return state.menu ? [media, remove].filter(el => !state.hideActions?.includes(el.kind)) : [];
      if (selector === S.dialog) return state.dialog ? [dialog] : [];
      if (selector === S.fileInput) return state.missingCoverInput ? [] : [coverInput];
      if (selector === S.cover) return [coverButton];
      return [];
    },
    body: {},
  };
  Object.defineProperty(document.body, 'innerText', { get: () => `发布\n${state.saved}\n${state.text.length} 个字\n${state.processingText}\n${state.leftPublished ? '已发布 Published 其他已发布文章' : ''}` });
  class DataTransfer { values = {}; setData(type, value) { this.values[type] = value; } }
  class ClipboardEvent { constructor(type, options) { Object.assign(this, options); } }
  const page = {
    async ensureRendering() { calls.push(['ensureRendering']); },
    async navigate(url) {
      calls.push(['navigate', url]);
      state.pathname = state.redirect ?? new URL(url).pathname;
      if (state.pathname.includes('/edit/')) state.title ||= 'Existing';
      if (state.oldCoverResponse) response('ArticleEntityUpdateCoverMedia');
      if (url.includes('/edit/')) lookupArticle();
    },
    async call(fn, ...args) {
      return runInNewContext(`(${fn.toString()})(...args)`, { args, document, location: state, DataTransfer, ClipboardEvent,
        window: { scrollTo(...args) { calls.push(['scroll', ...args]); } }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 } });
    },
    async waitFor(fn, args = [], waitOptions = {}) {
      calls.push(['waitFor', waitOptions.timeout]);
      const deadline = Date.now() + (waitOptions.timeout ?? 30000);
      for (let i = 0; state.pollWaits || i < 3; i++) {
        const result = await this.call(fn, ...args);
        calls.push(['waitResult', result]);
        if (result) return result;
        if (state.pendingImages && !state.uploadError) {
          state.images += state.pendingImages; state.pendingImages = 0; state.dialog = null; state.imagePolls++;
          if (state.processingStages) Object.assign(state, state.processingStages[0]);
          if (!state.noSave) response('ArticleEntityUpdateContent');
        } else if (state.processingStages && (state.processingText || state.cancelUpload)) {
          calls.push(['processing', state.processingText, state.cancelUpload]);
          state.processingIndex++;
          Object.assign(state, state.processingStages[state.processingIndex]);
        }
        if (state.pollWaits) {
          if (Date.now() >= deadline) return null;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      return null;
    },
    async click(selector) {
      const kind = tagged.get(selector)?.kind ?? ({ [S.create]: 'create', [S.insert]: 'insert', [S.confirm]: 'confirm', [S.cover]: 'coverButton',
        '[role=dialog] [data-testid=app-bar-close]': 'mediaClose' })[selector];
      calls.push(['click', kind ?? selector]);
      if (state.coveredClicks?.[kind] > 0) {
        state.coveredClicks[kind]--;
        throw new XPosterError('UI_CHANGED', '页面按钮被遮挡。');
      }
      if (state.missingClicks?.[kind] > 0) {
        state.missingClicks[kind]--;
        tagged.delete(selector);
        if (kind === 'media') media = element('media', state.english ? 'Media' : '媒体');
        throw new XPosterError('UI_CHANGED', '找不到页面按钮。');
      }
      if (kind === 'create') { state.pathname = '/compose/articles/edit/123'; state.title = ''; lookupArticle(); }
      if (kind === 'insert' || kind === 'more') state.menu = true;
      if (kind === 'media') { state.menu = false; state.dialog = 'media'; state.mediaOpens++; }
      if (kind === 'mediaClose') { state.dialog = null; if (state.imagesOnClose) state.images += state.imagesOnClose; }
      if (kind === 'coverButton' && !state.noChooser) {
        const opened = () => emit('Page.fileChooserOpened', { backendNodeId: 42 });
        if (state.chooserDelay) setTimeout(opened, state.chooserDelay);
        else opened();
      }
      if (kind === 'apply') {
        if (!state.cropStuck) state.dialog = null;
        state.cover = !state.noCover;
        state.coverReadyAt = Date.now() + (state.coverLoadDelay ?? 0);
        state.mediaInBody = state.mediaInDialog = false;
        if (state.processingStages) Object.assign(state, state.processingStages[0]);
        if (!state.noSave && !state.noCoverSave) {
          const save = () => {
            calls.push(['coverResponse', Date.now()]);
            response(state.coverOperation ?? 'ArticleEntityUpdateCoverMedia', state.coverBody ?? { data: { ok: true } },
              { articleEntityId: state.coverId ?? '123' }, state.coverStatus ?? 200);
          };
          if (state.coverDelay) setTimeout(save, state.coverDelay);
          else save();
        }
      }
      if (kind === 'publish') {
        if (state.confirmPublish) state.dialog = 'publish';
        else if (!state.noPublish) response('ArticleEntityPublish', state.publishBody ?? { data: { article_entity_publish: { article_results: { result: { rest_id: '123' } } } } }, state.publishVariables ?? { articleEntityId: '123' }, state.publishStatus ?? 200);
      }
      if (kind === 'delete') { state.menu = false; state.dialog = 'delete'; }
      if (kind === 'confirm') {
        if (state.dialog === 'delete') {
          if (!state.noDelete) response('ArticleEntityDelete', state.deleteBody ?? { data: { article_entity_delete: true } }, { articleEntityId: state.deleteId ?? '123' });
          state.pathname = '/compose/articles';
        } else if (!state.noPublish) response('ArticleEntityPublish', { data: { article_entity_publish: { article_id: '123' } } });
        state.dialog = null;
      }
      if (state.clickError && ['publish', 'confirm'].includes(kind)) throw new Error('transport closed');
      calls.push(['clicked', kind, Date.now()]);
    },
    async press(key) {
      calls.push(['press', key]);
      if (key === 'Escape') {
        state.menu = false;
        if (state.dialog === 'media' && !state.mediaCloseStuck) {
          state.dialog = null;
          if (state.imagesOnClose) state.images += state.imagesOnClose;
        }
      }
    },
    async insertText(value) { state.title += value; response('ArticleEntityUpdateTitle'); },
    async setFiles(selector, paths) {
      calls.push(['files', selector, paths]);
      if (selector === S.mediaInput) { state.pendingImages = paths.length; }
      else state.dialog = 'crop';
    },
    async send(method, params) {
      calls.push(['send', method, params]);
      if (method === 'DOM.setFileInputFiles') state.dialog = 'crop';
      if (method === 'Network.getResponseBody') return { body: JSON.stringify(bodies.get(params.requestId)), base64Encoded: false };
      return {};
    },
    on(method, handler) { if (!handlers.has(method)) handlers.set(method, new Set()); handlers.get(method).add(handler); return () => handlers.get(method).delete(handler); },
    async screenshot() {
      calls.push(['screenshot', Date.now()]);
      if (state.dialog === 'media') {
        state.mediaFrames++;
        state.mediaReadyAt = Date.now() + 250;
        if (state.imagesOnFrame) state.images += state.imagesOnFrame;
        if (state.mediaScreenshotError) throw new Error('frame capture failed');
      }
      if (state.screenshotError) throw new Error('screenshot failed');
      return Buffer.from('mock PNG');
    },
    async close() { state.closed = true; },
  };
  return { page, browser: { newPage: async () => page }, state, calls, response,
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0) };
}

const clockTimes = new WeakMap();
async function runClock(t, action, browserWork = false) {
  const now = Math.max(Date.now(), clockTimes.get(t) ?? 0);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let outcome;
  try {
    // Observe rejection immediately, but leave real I/O turns available between timer callbacks.
    Promise.resolve().then(action).then(
      value => { outcome = { value }; },
      error => { outcome = { error }; },
    );
    const deadline = performance.now() + 2000;
    while (!outcome) {
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(performance.now() < deadline, 'virtual-clock operation did not settle within 2 seconds');
      // Let real lock I/O finish before advancing simulated browser timers.
      if (!outcome && (!browserWork || holdsLock(join(config.home, 'browser.lock')))) t.mock.timers.runAll();
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    clockTimes.set(t, Date.now());
    t.mock.timers.reset();
  }
}

function runToolClock(t, action) { return runClock(t, action, true); }

async function input(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-article-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { title: '新文章', segments: [{ type: 'html', html: '<p>正文</p>', text: '正文' }], screenshotPath: join(dir, 'preview.png'), ...extra };
}

test('draft creates a new id, pastes rich HTML, awaits save and returns a screenshot', async t => {
  const f = fixture();
  const args = await input(t);
  const ids = [];
  args.onArticleId = id => { ids.push(id); assert.equal(f.state.text, ''); };
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(result.article_id, '123');
  assert.deepEqual(ids, ['123']);
  assert.equal(result.edit_url, 'https://x.com/compose/articles/edit/123');
  assert.equal(result.title, args.title);
  assert.deepEqual(result.screenshot, await readFile(args.screenshotPath));
  assert.equal(result.images_expected, 0);
  assert.equal(result.cover, false);
  assert.match(result.word_count_text, /个字/);
  assert.ok(f.calls.some(call => call[1] === 'DocumentEnd'));
  assert.equal(f.state.closed, true);
  assert.equal(f.listenerCount(), 0);
  assert.equal(f.calls.some(call => ['publish', 'sidebarMore', 'delete'].includes(call[1])), false);
});

test('image insertion waits for media count and cover crop clicks Apply', async t => {
  const f = fixture({ english: true });
  const args = await input(t, { cover: '/tmp/cover.png', segments: [{ type: 'images', paths: ['/tmp/one.png', '/tmp/two.png'] }] });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(result.images_inserted, 2);
  assert.equal(result.images_expected, 2);
  assert.equal(result.cover, true);
  assert.equal(f.state.imagePolls, 1);
  assert.ok(f.calls.some(call => call[1] === 'apply'));
});

test('strict paste retries one dropped event and reports non-whitespace text counts', async t => {
  const f = fixture({ dropPastes: 1 });
  const args = await input(t, { segments: [{ type: 'html', html: '<p>正文 hello</p><p>世界</p>', text: '正文 hello\n世界\t ' }] });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 2);
  assert.equal(result.text_chars_inserted, 9);
  assert.equal(result.text_chars_expected, 9);
  assert.equal(f.state.text, args.segments[0].text);
});

test('strict paste rejects two dropped events even when innerText changes', async t => {
  const f = fixture({ dropPastes: 2 });
  const args = await input(t);
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => {
    assert.equal(error.code, 'UNCERTAIN');
    assert.equal(error.message, '文章正文粘贴不完整，草稿可能缺少内容。');
    assert.equal(error.details.article_id, '123');
    return true;
  });
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 2);
  assert.equal(f.state.closed, true);
  assert.equal(f.listenerCount(), 0);
});

test('strict paste rejects a partial gain below 60 percent without retrying', async t => {
  const f = fixture({ pasteLimit: 2 });
  const args = await input(t, { segments: [{ type: 'html', html: '<p>abcdefghij</p>', text: 'abcdefghij' }] });
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => {
    assert.equal(error.code, 'UNCERTAIN');
    assert.equal(error.message, '文章正文粘贴不完整，草稿可能缺少内容。');
    return true;
  });
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
  assert.equal(f.state.text, 'ab');
});

test('text paste after images waits at least one second and two stable stats polls', async t => {
  const f = fixture();
  let finishedAt;
  const originalWait = f.page.waitFor;
  t.mock.method(f.page, 'waitFor', async function (fn, ...args) {
    const result = await originalWait.call(this, fn, ...args);
    if (fn.toString().includes('Processing media') && result) finishedAt = Date.now();
    return result;
  });
  const args = await input(t, { segments: [
    { type: 'images', paths: ['/tmp/one.png'] },
    { type: 'html', html: '<p>After image</p>', text: 'After image' },
  ] });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  const pastedAt = f.calls.find(call => call[0] === 'paste')[2];
  assert.ok(finishedAt !== undefined);
  assert.ok(pastedAt - finishedAt >= 1250, `paste ran ${pastedAt - finishedAt} ms after images finished`);
  assert.equal(result.images_inserted, 1);
  assert.equal(result.text_chars_inserted, 10);
  assert.equal(result.text_chars_expected, 10);
});

test('editor that never settles after images fails within five simulated seconds', async t => {
  const f = fixture({ unstableBlocks: true });
  let finishedAt;
  const originalWait = f.page.waitFor;
  t.mock.method(f.page, 'waitFor', async function (fn, ...args) {
    const result = await originalWait.call(this, fn, ...args);
    if (fn.toString().includes('Processing media') && result) finishedAt = Date.now();
    return result;
  });
  const args = await input(t, { segments: [
    { type: 'images', paths: ['/tmp/one.png'] }, { type: 'html', html: '<p>Later</p>', text: 'Later' },
  ] });
  await runClock(t, async () => {
    await assert.rejects(createArticleDraft(f.browser, args), error => error.code === 'UNCERTAIN');
    assert.ok(Date.now() - finishedAt <= 5000);
  });
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 0);
});

test('final text total below 90 percent fails despite passing each paste threshold', async t => {
  const f = fixture({ pasteLimit: 8 });
  const args = await input(t, { segments: [{ type: 'html', html: '<p>abcdefghij</p>', text: 'abcdefghij' }] });
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => {
    assert.equal(error.code, 'UNCERTAIN');
    assert.equal(error.message, '文章正文字数与 Markdown 不一致，请检查草稿。');
    return true;
  });
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
});

test('happy path reports text counts from text nodes, excluding whitespace and composer UI text', async t => {
  const f = fixture({ innerTextNoise: '不可计入正文的界面文字' });
  const args = await input(t, { segments: [
    { type: 'html', html: '<p>A B</p>', text: 'A B\n' },
    { type: 'html', html: '<p>正文</p>', text: ' 正\t文 ' },
  ] });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(result.text_chars_inserted, 4);
  assert.equal(result.text_chars_expected, 4);
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 2);
});

test('late original paste during retry delay is never duplicated, even when only partial', async t => {
  const args = await input(t, { segments: [{ type: 'html', html: '<p>abcdefghij</p>', text: 'abcdefghij' }] });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (const text of ['abcdefghij', 'ab']) {
    const f = fixture({ dropPastes: 1 });
    const originalCall = f.page.call;
    t.mock.method(f.page, 'call', async function (fn, ...values) {
      const result = await originalCall.call(this, fn, ...values);
      if (fn.toString().includes('ClipboardEvent')) setTimeout(() => {
        f.state.text += text;
        f.state.textBlocks++;
        f.response('ArticleEntityUpdateContent');
      }, 5500);
      return result;
    });
    if (text.length === 10) {
      const result = await jobClock(t, createArticleDraft(f.browser, args));
      assert.equal(result.text_chars_inserted, 10);
    } else {
      await assert.rejects(jobClock(t, createArticleDraft(f.browser, args)), error => error.code === 'UNCERTAIN'
        && error.message === '文章正文粘贴不完整，草稿可能缺少内容。');
    }
    assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
    assert.equal(f.state.text, text);
  }
});

test('editor settle compares both block and character counts before continuing', async t => {
  const f = fixture();
  const readings = [{ blocks: 1, textChars: 0 }, { blocks: 2, textChars: 0 },
    { blocks: 2, textChars: 1 }, { blocks: 2, textChars: 1 }];
  const originalCall = f.page.call;
  let finishedAt;
  const originalWait = f.page.waitFor;
  t.mock.method(f.page, 'waitFor', async function (fn, ...args) {
    const result = await originalWait.call(this, fn, ...args);
    if (fn.toString().includes('Processing media') && result) finishedAt = Date.now();
    return result;
  });
  t.mock.method(f.page, 'call', async function (fn, ...args) {
    if (fn.toString().includes('[data-block=true]') && readings.length) return readings.shift();
    return originalCall.call(this, fn, ...args);
  });
  const args = await input(t, { segments: [
    { type: 'images', paths: ['/tmp/one.png'] }, { type: 'html', html: '<p>正文</p>', text: '正文' },
  ] });
  await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(readings.length, 0);
  assert.equal(f.calls.find(call => call[0] === 'paste')[2] - finishedAt, 1750);
});

test('text thresholds accept exactly 90 percent overall and floor the per-paste minimum', async t => {
  for (const [text, pasteLimit, succeeds] of [['abcdefghij', 9, true], ['abcdefg', 4, false]]) {
    const f = fixture({ pasteLimit });
    const args = await input(t, { segments: [{ type: 'html', html: `<p>${text}</p>`, text }] });
    if (succeeds) {
      const result = await runClock(t, () => createArticleDraft(f.browser, args));
      assert.equal(result.text_chars_inserted, 9);
      assert.equal(result.text_chars_expected, 10);
    } else {
      await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => error.code === 'UNCERTAIN'
        && error.message === '文章正文字数与 Markdown 不一致，请检查草稿。');
    }
    assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
  }
});

test('media input absent until a screenshot opens on the first attempt and sets the group once', async t => {
  const f = fixture({ mediaInputMode: 'frame', pollWaits: true });
  const paths = ['/tmp/one.png', '/tmp/two.png'];
  const args = await input(t, { segments: [{ type: 'images', paths }] });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(result.images_inserted, 2);
  assert.equal(f.state.mediaOpens, 1);
  assert.equal(f.state.mediaFrames, 1);
  const files = f.calls.filter(call => call[0] === 'files' && call[1] === S.mediaInput);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0][2], paths);
  assert.equal(f.calls.filter(call => call[0] === 'screenshot').length, 2, 'one discarded frame plus the final preview');
});

test('media input absent until reopen retries Insert and Media, including failed frame captures', async t => {
  for (const options of [{}, { mediaCloseButton: true }, { mediaScreenshotError: true }]) {
    const f = fixture({ mediaInputMode: 'reopen', pollWaits: true, ...options });
    const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
    const result = await runClock(t, () => createArticleDraft(f.browser, args));
    assert.equal(result.images_inserted, 1);
    for (const kind of ['insert', 'media']) assert.equal(f.calls.filter(call => call[0] === 'clicked' && call[1] === kind).length, 2);
    assert.equal(f.calls.filter(call => call[0] === 'files' && call[1] === S.mediaInput).length, 1);
    assert.equal(f.state.mediaFrames, 1);
    if (options.mediaCloseButton) assert.equal(f.calls.filter(call => call[0] === 'clicked' && call[1] === 'mediaClose').length, 1);
  }
});

test('media input never appears: three attempts fail within 30 simulated seconds without setting files', async t => {
  const f = fixture({ mediaInputMode: 'never', pollWaits: true });
  const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
  await runClock(t, async () => {
    const started = Date.now();
    await assert.rejects(createArticleDraft(f.browser, args), error => {
      assert.equal(error.code, 'UI_CHANGED');
      assert.equal(error.message, '文章媒体上传窗口未打开。');
      assert.equal(error.details.attempts, 3);
      assert.equal(error.details.article_id, '123');
      assert.ok(error.details.edit_url.endsWith('/123'));
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 15000 && elapsed < 30000, `media retries took ${elapsed} ms`);
    t.diagnostic(`media dialog exhausted in ${elapsed} ms simulated`);
  });
  assert.equal(f.state.mediaOpens, 3);
  assert.equal(f.state.mediaFrames, 3);
  assert.equal(f.calls.filter(call => call[0] === 'files').length, 0);
  assert.equal(f.state.closed, true);
  assert.equal(f.listenerCount(), 0);
});

test('media retry stops as UNCERTAIN when image count increases before or during dialog close', async t => {
  for (const options of [{ imagesOnFrame: 1 }, { imagesOnClose: 1 }]) {
    const f = fixture({ mediaInputMode: 'reopen', pollWaits: true, ...options });
    const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
    await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => {
      assert.equal(error.code, 'UNCERTAIN');
      assert.equal(error.details.article_id, '123');
      assert.ok(error.details.edit_url.endsWith('/123'));
      assert.match(error.hint, /不要.*重试/);
      return true;
    });
    assert.equal(f.state.mediaOpens, 1);
    assert.equal(f.calls.filter(call => call[0] === 'files').length, 0);
    assert.equal(f.listenerCount(), 0);
  }
});

test('media retries never reopen a dialog that Escape failed to close', async t => {
  const f = fixture({ mediaInputMode: 'never', pollWaits: true, mediaCloseStuck: true });
  const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => error.code === 'UI_CHANGED');
  assert.equal(f.state.mediaOpens, 1);
  assert.equal(f.calls.filter(call => call[0] === 'files').length, 0);
});

test('second image group recovers its stalled dialog without resending any of seven images', async t => {
  const f = fixture({ pollWaits: true });
  const segments = Array.from({ length: 7 }, (_, i) => ({ type: 'images', paths: [`/tmp/image-${i + 1}.png`] }));
  const originalClick = f.page.click;
  t.mock.method(f.page, 'click', async selector => {
    if (selector === S.insert && f.state.images === 1) f.state.mediaInputMode = 'reopen';
    await originalClick(selector);
  });
  const originalCall = f.page.call;
  t.mock.method(f.page, 'call', async function (fn, ...args) {
    if (args[0] === S.mediaInput && f.state.mediaOpens === 2) return null;
    return originalCall.call(this, fn, ...args);
  });
  const args = await input(t, { segments });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(result.images_inserted, 7);
  assert.equal(f.state.mediaOpens, 8);
  const groups = f.calls.filter(call => call[0] === 'files' && call[1] === S.mediaInput);
  assert.deepEqual(groups.map(call => call[2]), segments.map(segment => segment.paths));
  assert.equal(f.state.mediaFrames, 1);
});

test('save requires final content response; earlier title save and failed GraphQL updates do not count', async t => {
  const args = await input(t);
  for (const options of [{ noSave: true }, { saveError: true }]) {
    const f = fixture(options);
    await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => error.code === 'UNCERTAIN' && error.details.edit_url.endsWith('/123'));
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
  }
});

test('changed last-saved indicator is a fallback when content network events are unavailable', async t => {
  const f = fixture({ noSave: true, indicatorSave: true });
  assert.equal((await runClock(t, async () => createArticleDraft(f.browser, await input(t)))).article_id, '123');
});

test('unavailable articles and failed uploads fail without publishing', async t => {
  const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
  for (const [options, code] of [[{ create: false }, 'ARTICLES_UNAVAILABLE'], [{ uploadError: '图片上传失败' }, 'UPLOAD_FAILED']]) {
    const f = fixture(options);
    await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => error.code === code);
    assert.equal(f.state.closed, true);
    assert.equal(f.listenerCount(), 0);
  }
});

test('publish works with and without confirmation, supports English and removes watchers', async t => {
  for (const options of [{}, { confirmPublish: true }, { confirmPublish: true, sheetConfirm: true, english: true }]) {
    const f = fixture(options);
    const result = await runClock(t, () => publishArticle(f.browser, '123'));
    assert.equal(result.article_id, '123');
    assert.equal(result.url, 'https://x.com/alice/article/123');
    assert.equal(f.calls.filter(call => call[0] === 'click' && call[1] === 'publish').length, 1);
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
  }
});

test('publish missing response, errors, mismatched id or ambiguous body are UNCERTAIN and never retry', async t => {
  for (const options of [{ noPublish: true }, { publishBody: {} }, { publishBody: { errors: [{}], data: { article_id: '123' } } }, { publishStatus: 500 }, { publishVariables: { articleEntityId: '999' } }, { clickError: true }]) {
    const f = fixture(options);
    await assert.rejects(runClock(t, () => publishArticle(f.browser, '123')), error => error.code === 'UNCERTAIN' && /不要.*重试/.test(error.hint));
    assert.equal(f.calls.filter(call => call[0] === 'click' && call[1] === 'publish').length, 1);
    assert.equal(f.listenerCount(), 0);
  }
});

test('delete scopes the top-bar more button, matches mutation id and verifies refreshed list', async t => {
  const f = fixture();
  assert.deepEqual(await runClock(t, () => deleteArticleDraft(f.browser, '123')), { article_id: '123', deleted: true });
  assert.equal(f.calls.some(call => call[1] === 'sidebarMore'), false);
  assert.equal(f.calls.filter(call => call[0] === 'navigate' && call[1] === 'https://x.com/compose/articles').length, 1);
  assert.equal(f.state.closed, true);
  assert.equal(f.listenerCount(), 0);
});

test('delete remains uncertain for missing/mismatched responses, GraphQL errors or remaining link', async t => {
  for (const options of [{ noDelete: true }, { deleteId: '999' }, { deleteBody: { errors: [{}] } }, { remains: true }]) {
    const f = fixture(options);
    await assert.rejects(runClock(t, () => deleteArticleDraft(f.browser, '123')), error => error.code === 'UNCERTAIN');
    assert.equal(f.calls.filter(call => call[0] === 'click' && call[1] === 'confirm').length, 1);
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
  }
});

async function toolFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-article-tools-'));
  const previous = { ...config };
  Object.assign(config, { home: dir, previewsDir: join(dir, 'previews'), historyFile: join(dir, 'history.jsonl'), chromePath: '/fake/chrome' });
  t.after(async () => { Object.assign(config, previous); await rm(dir, { recursive: true, force: true }); });
  const markdown_path = join(dir, 'article.md');
  await writeFile(markdown_path, '# Title\n正文');
  const f = fixture(options);
  const browser = { isLoggedIn: async () => !options.loggedOut, newPage: async () => f.page, close: async () => { f.state.browserClosed = true; } };
  const opened = t.mock.method(Browser, 'open', async () => browser);
  return { ...f, dir, markdown_path, opened };
}

test('article argument, file, cover and image validation all precede browser work', async t => {
  const f = await toolFixture(t);
  for (const args of [undefined, null, [], {}, { markdown_path: 'relative.md' }, { markdown_path: f.dir },
    { markdown_path: f.markdown_path, title: '' }, { markdown_path: f.markdown_path, cover: 'relative.png' },
    { markdown_path: f.markdown_path, extra: true }, { markdown_path: join(f.dir, 'missing.md') }]) {
    await assert.rejects(articleDraft(args), error => error.code === 'INVALID_INPUT');
  }
  for (const fn of [articlePublish, articleDelete]) for (const args of [undefined, null, [], {}, { article_id: 123 }, { article_id: '' }, { article_id: '1\n' }, { article_id: '../2' }, { article_id: '1', extra: true }]) {
    await assert.rejects(fn(args), error => error.code === 'INVALID_INPUT');
  }
  for (const source of ['# T\n![missing](missing.png)', '---\ntitle: T\ncover: missing.png\n---\n正文', '# T\n']) {
    await writeFile(f.markdown_path, source);
    await assert.rejects(articleDraft({ markdown_path: f.markdown_path }), error => error.code === 'INVALID_INPUT');
  }
  await truncate(f.markdown_path, 1024 * 1024 + 1);
  await assert.rejects(articleDraft({ markdown_path: f.markdown_path }), error => error.code === 'INVALID_INPUT');
  assert.equal(f.opened.mock.callCount(), 0);
});

test('draft MCP returns image, warnings and review instructions with no publication history', async t => {
  const f = await toolFixture(t);
  await writeFile(f.markdown_path, '# T\n正文\n---');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const result = await jobClock(t, callTool('x_article_draft', { markdown_path: f.markdown_path, title: 'Override' }));
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.title, 'Override');
  assert.equal(data.article_id, '123');
  assert.match(data.next_step, /x_article_publish/);
  assert.equal(data.warnings.length, 1);
  assert.equal(result.content[1].type, 'image');
  assert.equal((await readFile(data.screenshot)).toString('base64'), result.content[1].data);
  assert.deepEqual(await readHistory(config.historyFile), []);
  assert.equal(f.state.browserClosed, true);
});

test('publish records history and consumes limits; delete remains usable at the limit', async t => {
  const f = await toolFixture(t);
  const result = await runToolClock(t, () => articlePublish({ article_id: '123' }));
  assert.equal(result.data.article_id, '123');
  const history = await readHistory(config.historyFile);
  assert.deepEqual(Object.keys(history[0]).sort(), ['article_id', 'ts', 'url']);
  assert.equal(history[0].article_id, '123');
  await assert.rejects(articlePublish({ article_id: '123' }), error => error.code === 'RATE_LIMITED');
  assert.equal(f.opened.mock.callCount(), 1);
  await runToolClock(t, () => articleDelete({ article_id: '123' }));
  const after = await readHistory(config.historyFile);
  assert.equal(after[1].deleted_article, '123');
  const limits = { now: Date.now(), minIntervalSec: 60, dailyLimit: 20 };
  assert.deepEqual(checkRateLimit(after, limits), checkRateLimit(history, limits));
});

test('uncertain article publication is counted once and not retried', async t => {
  const f = await toolFixture(t, { noPublish: true });
  const result = await runToolClock(t, () => callTool('x_article_publish', { article_id: '123' }));
  assert.equal(JSON.parse(result.content[0].text).code, 'UNCERTAIN');
  const history = await readHistory(config.historyFile);
  assert.equal(history.length, 1);
  assert.equal(history[0].article_id, '123');
  assert.equal(history[0].uncertain, true);
  assert.equal(f.calls.filter(call => call[0] === 'click' && call[1] === 'publish').length, 1);
  assert.equal(f.state.browserClosed, true);
});

test('articles check login and close the browser without navigating when logged out', async t => {
  const f = await toolFixture(t, { loggedOut: true });
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  for (const action of [() => articleDraft({ markdown_path: f.markdown_path }), () => articleCover({ article_id: '123', cover }), () => articlePublish({ article_id: '123' }), () => articleDelete({ article_id: '123' })]) {
    await assert.rejects(action(), error => error.code === 'NOT_LOGGED_IN');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.browserClosed, true);
});

test('article publish and delete require Codex tool approval while draft and cover do not', async () => {
  const configuration = JSON.parse(await readFile(new URL('../.codex-mcp.json', import.meta.url), 'utf8'));
  const tools = configuration.mcpServers['x-poster'].tools;
  assert.equal(tools.x_article_publish.approval_mode, 'prompt');
  assert.equal(tools.x_article_delete.approval_mode, 'prompt');
  assert.equal(tools.x_article_draft, undefined);
  assert.equal(tools.x_article_cover, undefined);
});

test('autosave waits for the last content request and a full three-second quiet period', async t => {
  const f = fixture();
  const args = await input(t, { segments: [
    { type: 'html', html: '<p>First</p>', text: 'First' },
    { type: 'html', html: '<p>Last</p>', text: 'Last' },
  ] });
  const originalCall = f.page.call;
  let delayed = false;
  f.page.call = async function (fn, ...values) {
    const result = await originalCall.call(this, fn, ...values);
    if (!delayed && f.state.text.includes('Last')) {
      delayed = true;
      setTimeout(() => f.response('ArticleEntityUpdateContent'), 2000);
    }
    return result;
  };
  const elapsed = await runClock(t, async () => {
    const began = Date.now();
    await createArticleDraft(f.browser, args);
    return Date.now() - began;
  });
  assert.ok(elapsed >= 5000);
  assert.equal(f.listenerCount(), 0);
});

test('closed upload dialog without new media is still UPLOAD_FAILED', async t => {
  const f = fixture();
  const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
  f.page.setFiles = async () => { f.state.dialog = null; };
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => error.code === 'UPLOAD_FAILED');
});

test('cover applies the Chinese crop button and verifies the result', async t => {
  const f = fixture();
  const args = await input(t, { cover: '/tmp/cover.png' });
  assert.equal((await runClock(t, () => createArticleDraft(f.browser, args))).cover, true);
  assert.equal(f.calls.filter(call => call[0] === 'click' && call[1] === 'apply').length, 1);
});

test('publish returns the confirmed id even if the profile is unavailable after navigation', async t => {
  const f = fixture();
  const originalCall = f.page.call;
  f.page.call = async function (fn, ...args) {
    if (args[0] === S.profileLink) throw new Error('Execution context destroyed');
    return originalCall.call(this, fn, ...args);
  };
  assert.deepEqual(await runClock(t, () => publishArticle(f.browser, '123')), { article_id: '123' });
});

test('history write failure after successful article operations stays UNCERTAIN', async t => {
  const f = await toolFixture(t);
  config.historyFile = f.dir;
  t.mock.method(console, 'error', () => {});
  await assert.rejects(runToolClock(t, () => articleDelete({ article_id: '123' })), error => error.code === 'UNCERTAIN' && /历史记录/.test(error.message));
  assert.equal(f.state.browserClosed, true);
});

test('a local screenshot failure after draft creation preserves id and edit_url as UNCERTAIN', async t => {
  const f = fixture();
  const args = await input(t);
  args.screenshotPath = join(args.screenshotPath, 'missing-parent.png');
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => error.code === 'UNCERTAIN' && error.details.article_id === '123' && error.details.edit_url.endsWith('/123'));
  assert.equal(f.state.closed, true);
  assert.equal(f.listenerCount(), 0);
});

test('menu items are clicked only after two equal rect reads 150 ms apart', async t => {
  for (const kind of ['media', 'delete']) {
    const f = fixture({ rects: { [kind]: [0, 20, 20] } });
    const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
    await runClock(t, () => kind === 'media' ? createArticleDraft(f.browser, args) : deleteArticleDraft(f.browser, '123'));
    const reads = f.calls.filter(call => call[0] === 'rect' && call[1] === kind);
    assert.deepEqual(reads.map(call => call[2]), [0, 20, 20]);
    assert.equal(reads[1][3] - reads[0][3], 150);
    assert.equal(reads[2][3] - reads[1][3], 150);
    const clicks = f.calls.filter(call => call[0] === 'clicked' && call[1] === kind);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0][2], reads[2][3]);
  }
});

test('covered insert, menu and confirmation clicks succeed on retry', async t => {
  for (const kind of ['insert', 'media', 'confirm']) {
    const f = fixture({ coveredClicks: { [kind]: 1 } });
    const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
    await runClock(t, () => kind === 'confirm' ? deleteArticleDraft(f.browser, '123') : createArticleDraft(f.browser, args));
    assert.equal(f.calls.filter(call => call[0] === 'click' && call[1] === kind).length, 2);
    assert.equal(f.calls.filter(call => call[0] === 'clicked' && call[1] === kind).length, 1);
    assert.equal(f.listenerCount(), 0);
  }
});

test('a menu item removed by a rerender is found and tagged again before retrying', async t => {
  const f = fixture({ missingClicks: { media: 1 } });
  const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(result.images_inserted, 1);
  assert.equal(f.calls.filter(call => call[0] === 'click' && call[1] === 'media').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'clicked' && call[1] === 'media').length, 1);
  assert.ok(f.state.rectReads.media >= 3);
});

test('inline media waits for both processing text and the cancel-upload button to disappear', async t => {
  for (const english of [false, true]) {
    const text = english ? 'Processing media…' : '正在处理媒体…';
    const f = fixture({ english, processingStages: [
      { processingText: text, cancelUpload: false },
      { processingText: '', cancelUpload: true },
      { processingText: '', cancelUpload: false },
    ] });
    const args = await input(t, { segments: [
      { type: 'images', paths: ['/tmp/one.png'] },
      { type: 'html', html: '<p>After image</p>', text: 'After image' },
    ] });
    await runClock(t, () => createArticleDraft(f.browser, args));
    assert.deepEqual(f.calls.filter(call => call[0] === 'processing'), [
      ['processing', text, false], ['processing', '', true],
    ]);
    const processingIndex = f.calls.findLastIndex(call => call[0] === 'processing');
    const insertions = f.calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0] === 'press' && call[1] === 'DocumentEnd');
    assert.equal(insertions.length, 2);
    assert.ok(insertions[1].index > processingIndex, 'the next segment must wait for processing');
    assert.equal(f.state.processingIndex, 2);
    assert.ok(f.calls.filter(call => call[0] === 'waitFor' && call[1] === 120000).length >= 2);
  }
});

test('persistent media processing stops insertion with UPLOAD_FAILED', async t => {
  const stages = Array.from({ length: 4 }, () => ({ processingText: '正在处理媒体…', cancelUpload: true }));
  const f = fixture({ processingStages: stages });
  const args = await input(t, { segments: [
    { type: 'images', paths: ['/tmp/one.png'] }, { type: 'html', html: '<p>Later</p>', text: 'Later' },
  ] });
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error => error.code === 'UPLOAD_FAILED' && /处理超时/.test(error.message));
  assert.equal(f.calls.filter(call => call[0] === 'press' && call[1] === 'DocumentEnd').length, 1);
  assert.equal(f.state.closed, true);
  assert.equal(f.listenerCount(), 0);
});

test('top-bar more is found using a disabled Publish anchor', async t => {
  const f = fixture({ publishDisabled: true });
  assert.deepEqual(await runClock(t, () => deleteArticleDraft(f.browser, '123')), { article_id: '123', deleted: true });
  assert.equal(f.calls.some(call => call[0] === 'click' && call[1] === 'more'), true);
  assert.equal(f.calls.some(call => call[0] === 'click' && call[1] === 'sidebarMore'), false);
});

test('covered clicks retain the three-second deadline and missing menu items the five-second deadline', async t => {
  for (const [options, expectedTime] of [[{ coveredClicks: { insert: Infinity } }, 3000], [{ hideActions: ['media'] }, 5100]]) {
    const f = fixture(options);
    const args = await input(t, { segments: [{ type: 'images', paths: ['/tmp/one.png'] }] });
    const elapsed = await runClock(t, async () => {
      const start = Date.now();
      await assert.rejects(createArticleDraft(f.browser, args), error => error.code === 'UI_CHANGED');
      return Date.now() - start;
    });
    assert.equal(elapsed, expectedTime);
    assert.equal(f.state.closed, true);
    assert.equal(f.listenerCount(), 0);
  }
});

test('virtual clock drives operations past 200 I/O turns and resets after success and rejection', async t => {
  const originalDate = Date;
  const originalTimeout = setTimeout;
  const value = await runClock(t, async () => {
    for (let i = 0; i < 250; i++) await new Promise(resolve => setImmediate(resolve));
    const start = Date.now();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(Date.now() - start, 150);
    return 'finished';
  });
  assert.equal(value, 'finished');
  assert.equal(Date, originalDate);
  assert.equal(setTimeout, originalTimeout);
  const failure = new Error('expected failure');
  await assert.rejects(runClock(t, () => { throw failure; }), error => error === failure);
  assert.equal(Date, originalDate);
  assert.equal(setTimeout, originalTimeout);
  assert.equal(await runClock(t, () => 'usable again'), 'usable again');
});

test('existing draft cover waits for settled Apply, processing and a fresh CoverMedia save', async t => {
  for (const cover of [false, true]) {
    const f = fixture({ cover, title: 'Original title', text: 'Original body', images: 2, english: cover,
      rects: { apply: [0, 20, 20] }, coverDelay: 2000, processingStages: [
        { processingText: cover ? 'Processing media…' : '正在处理媒体…', cancelUpload: false },
        { processingText: '', cancelUpload: true }, { processingText: '', cancelUpload: false },
      ] });
    const args = await input(t, { cover: '/tmp/cover.png' });
    const result = await runClock(t, () => setArticleCover(f.browser, '123', args));
    assert.equal(result.article_id, '123');
    assert.equal(result.edit_url, 'https://x.com/compose/articles/edit/123');
    assert.equal(result.replaced, cover);
    assert.equal(result.cover, true);
    assert.deepEqual(result.screenshot, await readFile(args.screenshotPath));
    const reads = f.calls.filter(call => call[0] === 'rect' && call[1] === 'apply');
    assert.deepEqual(reads.map(call => call[2]), [0, 20, 20]);
    assert.equal(reads[2][3] - reads[1][3], 150);
    assert.equal(f.calls.find(call => call[0] === 'clicked' && call[1] === 'apply')[2], reads[2][3]);
    assert.equal(f.calls.filter(call => call[0] === 'files').length, 1);
    assert.equal(f.state.processingIndex, 2);
    assert.ok(f.calls.find(call => call[0] === 'screenshot')[1] >= f.calls.find(call => call[0] === 'coverResponse')[1]);
    assert.deepEqual(f.calls.filter(call => call[0] === 'scroll'), [['scroll', 0, 0]]);
    assert.equal(f.state.title, 'Original title');
    assert.equal(f.state.text, 'Original body');
    assert.equal(f.state.images, 2);
    assert.equal(f.calls.some(call => call[0] === 'press' || call[0] === 'click' && call[1] !== 'apply'), false);
    assert.equal(f.state.closed, true);
    assert.equal(f.listenerCount(), 0);
  }
});

test('existing cover without input uses intercepted file chooser and cleans it up', async t => {
  const f = fixture({ cover: true, missingCoverInput: true, chooserDelay: 200 });
  const args = await input(t, { cover: '/tmp/replacement.webp' });
  const result = await runClock(t, () => setArticleCover(f.browser, '123', args));
  assert.equal(result.replaced, true);
  assert.equal(result.cover, true);
  const sends = f.calls.filter(call => call[0] === 'send');
  assert.deepEqual(sends.filter(call => call[1] === 'Page.setInterceptFileChooserDialog').map(call => call[2]),
    [{ enabled: true }, { enabled: false }]);
  assert.deepEqual(sends.find(call => call[1] === 'DOM.setFileInputFiles')[2], { backendNodeId: 42, files: [args.cover] });
  assert.equal(f.calls.some(call => call[0] === 'files'), false);
  assert.equal(f.listenerCount(), 0);
  assert.equal(f.state.closed, true);
});

test('cover save requires fresh matching CoverMedia 200 without GraphQL errors', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const options of [{ noSave: true }, { noSave: true, oldCoverResponse: true },
    { coverOperation: 'ArticleEntityUpdateContent' }, { coverId: '999' }, { coverStatus: 500 },
    { coverBody: { data: { ok: true }, errors: [{ message: 'denied' }] } }]) {
    const f = fixture(options);
    await runClock(t, async () => {
      const start = Date.now();
      await assert.rejects(setArticleCover(f.browser, '123', args), error => {
        assert.equal(error.code, 'UNCERTAIN');
        assert.equal(error.details.article_id, '123');
        assert.equal(error.details.edit_url, 'https://x.com/compose/articles/edit/123');
        return true;
      });
      if (options.noSave) assert.equal(Date.now() - start, 60150);
    });
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
  }
});

test('cover failures close pages, stop watchers and never publish', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const [options, code] of [[{ cropStuck: true }, 'UPLOAD_FAILED'],
    [{ redirect: '/compose/articles' }, 'INVALID_INPUT'], [{ redirect: '/compose/articles/edit/999' }, 'INVALID_INPUT'],
    [{ missingCoverInput: true }, 'UI_CHANGED'], [{ cover: true, missingCoverInput: true, noChooser: true }, 'UPLOAD_FAILED'],
    [{ processingStages: Array(4).fill({ processingText: '正在处理媒体', cancelUpload: true }) }, 'UPLOAD_FAILED']]) {
    const f = fixture(options);
    await assert.rejects(runClock(t, () => setArticleCover(f.browser, '123', args)), error => error.code === code);
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
    assert.equal(f.calls.some(call => call[0] === 'click' && call[1] === 'publish'), false);
    if (options.noChooser) assert.ok(f.calls.some(call => call[1] === 'Page.setInterceptFileChooserDialog' && !call[2].enabled));
    if (options.redirect) assert.equal(f.calls.some(call => call[0] === 'files'), false);
  }
});

test('cover MCP rejects invalid id, path, format, size and missing files before opening Chrome', async t => {
  const f = await toolFixture(t);
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  for (const args of [undefined, null, [], {}, { article_id: 'bad', cover }, { article_id: '123\n', cover },
    { article_id: 123, cover }, { article_id: '123', cover: 'relative.png' }, { article_id: '123', cover: join(f.dir, 'cover.gif') },
    { article_id: '123', cover: join(f.dir, 'missing.png') }, { article_id: '123', cover: f.dir },
    { article_id: '123', cover, extra: true }, { article_id: '123' }]) {
    const result = await callTool('x_article_cover', args);
    assert.equal(JSON.parse(result.content[0].text).code, 'INVALID_INPUT');
  }
  await truncate(cover, 5 * 1024 * 1024 + 1);
  await assert.rejects(articleCover({ article_id: '123', cover }), error => error.code === 'INVALID_INPUT');
  assert.equal(f.opened.mock.callCount(), 0);
});

test('cover MCP returns image content without changing history or consuming limits', async t => {
  const f = await toolFixture(t, { cover: true });
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  const history = `${JSON.stringify({ ts: new Date().toISOString(), article_id: '999' })}\n`;
  await writeFile(config.historyFile, history);
  const result = await runToolClock(t, () => callTool('x_article_cover', { article_id: '123', cover }));
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.replaced, true);
  assert.equal(data.cover, true);
  assert.equal(result.content[1].type, 'image');
  assert.equal((await readFile(data.screenshot)).toString('base64'), result.content[1].data);
  assert.equal(await readFile(config.historyFile, 'utf8'), history);
  assert.equal(f.state.browserClosed, true);
});


test('cover detection ignores body, dialog and unrelated editor images', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const options of [{ cover: false, images: 3 }, { cover: true, mediaInBody: true }, { cover: true, mediaInDialog: true }]) {
    const f = fixture(options);
    const result = await runClock(t, () => setArticleCover(f.browser, '123', args));
    assert.equal(result.replaced, false);
    assert.equal(result.cover, true);
  }
});

test('cover MCP expands home paths and accepts the 5 MB boundary', async t => {
  const f = await toolFixture(t);
  const cover = join(f.dir, 'cover.JPEG');
  await writeFile(cover, 'image');
  await truncate(cover, 5 * 1024 * 1024);
  const result = await runToolClock(t, () => articleCover({ article_id: '123', cover: `~/${relative(homedir(), cover)}` }));
  assert.equal(result.data.cover, true);
  assert.deepEqual(f.calls.find(call => call[0] === 'files')[2], [cover]);
});

test('uncertain cover MCP keeps history unchanged and includes the draft id', async t => {
  const f = await toolFixture(t, { noSave: true });
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  const result = await runToolClock(t, () => callTool('x_article_cover', { article_id: '123', cover }));
  assert.equal(result.isError, true);
  const failure = JSON.parse(result.content[0].text);
  assert.equal(failure.code, 'UNCERTAIN');
  assert.equal(failure.article_id, '123');
  assert.equal(failure.edit_url, 'https://x.com/compose/articles/edit/123');
  assert.deepEqual(await readHistory(config.historyFile), []);
  assert.equal(f.state.browserClosed, true);
});


test('cover screenshots wait for the large image to load for new and existing drafts', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const create of [false, true]) {
    const f = fixture({ coverLoadDelay: 5000, extraCoverImages: ['body', 'dialog', 'thumbnail'] });
    const result = await runClock(t, () => create ? createArticleDraft(f.browser, args) : setArticleCover(f.browser, '123', args));
    assert.equal(result.cover, true);
    assert.equal(result.warning, undefined);
    assert.ok(f.calls.find(call => call[0] === 'screenshot')[1] >= f.state.coverReadyAt);
    assert.equal(f.state.closed, true);
    assert.equal(f.listenerCount(), 0);
  }
});

test('cover image load timeout still returns a successful screenshot with a warning', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const create of [false, true]) for (const imageState of [{ coverComplete: false }, { coverNaturalWidth: 0 }, { noCover: true }]) {
    if (create && imageState.noCover) continue;
    const f = fixture({ ...imageState, extraCoverImages: imageState.noCover ? ['body', 'dialog'] : ['body', 'dialog', 'thumbnail'] });
    const result = await runClock(t, () => create ? createArticleDraft(f.browser, args) : setArticleCover(f.browser, '123', args));
    assert.equal(result.cover, true);
    assert.match(result.warning, /截图.*封面/);
    assert.deepEqual(result.screenshot, await readFile(args.screenshotPath));
    const savedAt = f.calls.find(call => call[0] === 'coverResponse')[1];
    const screenshotAt = f.calls.find(call => call[0] === 'screenshot')[1];
    assert.equal(screenshotAt - savedAt, create ? 23000 : 20000);
    assert.equal(f.state.closed, true);
    assert.equal(f.listenerCount(), 0);
  }
});

test('MCP preserves cover-image timeout warnings for cover updates and draft creation', async t => {
  const f = await toolFixture(t, { coverComplete: false });
  // Exercise real lock I/O without charging it simulated browser time.
  config.home = join(f.dir, ...Array.from({ length: 60 }, (_, i) => 'l' + i));
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (const [tool, args] of [['x_article_cover', { article_id: '123', cover }],
    ['x_article_draft', { markdown_path: f.markdown_path, cover }]]) {
    const result = await jobClock(t, callTool(tool, args), { waitForLock: true });
    assert.equal(result.isError, undefined, result.content[0].text);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.ok, true);
    assert.match(data.warning, /截图.*封面/);
    assert.equal(result.content[1].type, 'image');
  }
});

test('published articles reject cover, publish and delete immediately without any clicks', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const english of [false, true]) {
    for (const [action, message] of [
      [browser => setArticleCover(browser, '123', args), '该文章已发布，x_article_cover 只能用于草稿。如需更换已发布文章的封面，请让用户在 X 网页上操作。'],
      [browser => publishArticle(browser, '123'), '该文章已发布。'],
      [browser => deleteArticleDraft(browser, '123'), '该文章已发布，x_article_delete 只删除草稿。'],
    ]) {
      const f = fixture({ published: true, english });
      await assert.rejects(runClock(t, () => action(f.browser)), error => {
        assert.equal(error.code, 'INVALID_INPUT');
        assert.equal(error.message, message);
        assert.equal(error.details.article_id, '123');
        assert.equal(error.details.edit_url, 'https://x.com/compose/articles/edit/123');
        return true;
      });
      assert.equal(f.calls.filter(call => call[0] === 'waitResult').length, 1);
      assert.equal(f.calls.some(call => call[0] === 'click' || call[0] === 'press' || call[0] === 'files'), false);
      assert.equal(f.state.closed, true);
      assert.equal(f.listenerCount(), 0);
    }
  }
});

test('left-list Published text does not classify a draft or a loading editor as published', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const action of [browser => setArticleCover(browser, '123', args),
    browser => publishArticle(browser, '123'), browser => deleteArticleDraft(browser, '123')]) {
    const f = fixture({ leftPublished: true });
    await runClock(t, () => action(f.browser));
  }
  const loading = fixture({ leftPublished: true, editorMissing: true });
  await assert.rejects(runClock(t, () => setArticleCover(loading.browser, '123', args)), error => error.code === 'UI_CHANGED');
});

test('draft cover requires a fresh matching successful CoverMedia response', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const options of [{ noCoverSave: true }, { noCoverSave: true, oldCoverResponse: true },
    { coverOperation: 'ArticleEntityUpdateContent' }, { coverId: '999' }, { coverStatus: 500 },
    { coverBody: { data: { ok: true }, errors: [{ message: 'denied' }] } }]) {
    const f = fixture(options);
    await runClock(t, async () => {
      const start = Date.now();
      await assert.rejects(createArticleDraft(f.browser, args), error => {
        assert.equal(error.code, 'UNCERTAIN');
        assert.equal(error.message, '无法确认文章封面已保存，请检查草稿。');
        assert.equal(error.details.article_id, '123');
        return true;
      });
      if (options.noCoverSave) assert.equal(Date.now() - start, 60150);
    });
    assert.equal(f.calls.some(call => call[0] === 'screenshot'), false);
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
  }
});

test('draft cover confirmation preserves the body save marker and indicator fallback', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const options of [{ coverDelay: 2000 }, { noSave: true, indicatorSave: true }]) {
    const f = fixture(options);
    if (options.noSave) {
      const originalClick = f.page.click;
      f.page.click = async function (selector) {
        await originalClick.call(this, selector);
        if (selector === '[data-x-poster-article="apply"]') f.response('ArticleEntityUpdateCoverMedia');
      };
    }
    const result = await runClock(t, () => createArticleDraft(f.browser, args));
    assert.equal(result.cover, true);
    assert.equal(result.warning, undefined);
  }
});

test('draft with confirmed cover save but no detected cover is UNCERTAIN', async t => {
  const f = fixture({ noCover: true, extraCoverImages: ['thumbnail'] });
  const args = await input(t, { cover: '/tmp/cover.png' });
  await assert.rejects(runClock(t, () => createArticleDraft(f.browser, args)), error =>
    error.code === 'UNCERTAIN' && /封面/.test(error.message));
});

test('draft rechecks a cover that appears while its image is loading', async t => {
  const f = fixture({ noCover: true });
  const args = await input(t, { cover: '/tmp/cover.png' });
  const originalClick = f.page.click;
  f.page.click = async function (selector) {
    await originalClick.call(this, selector);
    if (selector === '[data-x-poster-article="apply"]') setTimeout(() => { f.state.cover = true; }, 5000);
  };
  assert.equal((await runClock(t, () => createArticleDraft(f.browser, args))).cover, true);
});

test('redirected editors fail within five simulated seconds with operation-specific errors', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const [action, code] of [[browser => setArticleCover(browser, '123', args), 'INVALID_INPUT'],
    [browser => publishArticle(browser, '123'), 'UI_CHANGED'],
    [browser => deleteArticleDraft(browser, '123'), 'UI_CHANGED']]) {
    const f = fixture({ redirect: '/compose/articles' });
    f.state.pollWaits = true;
    await runClock(t, async () => {
      const start = Date.now();
      await assert.rejects(action(f.browser), error => {
        assert.equal(error.code, code);
        if (code === 'INVALID_INPUT') assert.equal(error.message, '文章草稿不存在或无法打开。');
        return true;
      });
      assert.ok(Date.now() - start < 5000);
      assert.equal(Date.now() - start, 2000);
    });
    assert.equal(f.calls.some(call => call[0] === 'files' || call[0] === 'click'), false);
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
  }
});

test('editor routing tolerates intermediate URLs and slow draft loading', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const options of [{ redirect: '/compose/articles' }, { editorMissing: true }]) {
    const f = fixture(options);
    f.state.pollWaits = true;
    await runClock(t, async () => {
      setTimeout(() => { f.state.pathname = '/compose/articles/edit/123'; f.state.editorMissing = false; },
        options.editorMissing ? 10000 : 1000);
      assert.equal((await setArticleCover(f.browser, '123', args)).cover, true);
    });
  }
});

test('login and challenge detection take priority over editor redirects', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const [redirect, code] of [['/i/flow/login', 'NOT_LOGGED_IN'], ['/account/access', 'ACCOUNT_CHALLENGE']]) {
    const f = fixture({ redirect });
    f.state.pollWaits = true;
    await runClock(t, async () => {
      const start = Date.now();
      await assert.rejects(setArticleCover(f.browser, '123', args), error => error.code === code);
      assert.equal(Date.now() - start, 0);
    });
  }
});

test('redirect stability resets while the expected editor is loading', async t => {
  const f = fixture({ redirect: '/compose/articles', editorMissing: true, pollWaits: true });
  const args = await input(t, { cover: '/tmp/cover.png' });
  await runClock(t, async () => {
    const start = Date.now();
    setTimeout(() => { f.state.pathname = '/compose/articles/edit/123'; }, 500);
    setTimeout(() => { f.state.pathname = '/compose/articles'; }, 1500);
    await assert.rejects(setArticleCover(f.browser, '123', args), error => error.code === 'INVALID_INPUT');
    assert.equal(Date.now() - start, 3500);
  });
});

test('transport failure after upload and before confirmation remains UNCERTAIN', async t => {
  const f = fixture({ noCoverSave: true });
  const args = await input(t, { cover: '/tmp/cover.png' });
  const originalClick = f.page.click;
  f.page.click = async function (selector) {
    await originalClick.call(this, selector);
    if (selector === '[data-x-poster-article="apply"]') throw new Error('transport closed');
  };
  await assert.rejects(runClock(t, () => setArticleCover(f.browser, '123', args)), error => error.code === 'UNCERTAIN');
  assert.equal(f.state.closed, true);
  assert.equal(f.listenerCount(), 0);
});

test('confirmed cover survives screenshot, file write and image snapshot failures', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const failure of ['screenshot', 'write', 'snapshot']) {
    const f = fixture({ screenshotError: failure === 'screenshot' });
    if (failure === 'snapshot') {
      const originalCall = f.page.call;
      f.page.call = async function (fn, ...values) {
        if (fn.name === 'snapshot' && f.calls.some(call => call[0] === 'scroll')) throw new Error('context destroyed');
        return originalCall.call(this, fn, ...values);
      };
    }
    const result = await runClock(t, () => setArticleCover(f.browser, '123', {
      ...args, screenshotPath: failure === 'write' ? join(args.screenshotPath, 'missing.png') : args.screenshotPath,
    }));
    assert.equal(result.cover, true);
    assert.equal(result.screenshot, null);
    assert.match(result.warning, /封面已保存.*截图.*失败/);
    assert.equal(f.state.closed, true);
    assert.equal(f.listenerCount(), 0);
  }
});

test('cover MCP returns success and warning without image when screenshot fails after save', async t => {
  const f = await toolFixture(t, { screenshotError: true });
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  const result = await runToolClock(t, () => callTool('x_article_cover', { article_id: '123', cover }));
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(data.cover, true);
  assert.equal(data.screenshot, null);
  assert.match(data.warning, /封面已保存.*截图.*失败/);
  assert.equal(result.content.length, 1);
  assert.deepEqual(await readHistory(config.historyFile), []);
  assert.equal(f.state.browserClosed, true);
});

test('snapshot cover detection rejects icons, avatars, emoji, hidden and cover-button media', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const options of [{ coverWidth: 32, coverNaturalWidth: 32 },
    { coverWidth: 32, coverComplete: false }, { coverAriaHidden: 'true' }, { coverHiddenAncestor: true },
    { coverSrc: 'https://pbs.twimg.com/profile_images/avatar.jpg' },
    { coverSrc: 'https://abs.twimg.com/emoji/v2/72x72/icon.png' },
    { mediaInCoverButton: true }]) {
    const f = fixture({ cover: true, ...options });
    const result = await runClock(t, () => setArticleCover(f.browser, '123', args));
    assert.equal(result.replaced, false, JSON.stringify(options));
  }
});

test('snapshot cover detection accepts large media and loaded natural image dimensions', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const options of [{ coverWidth: 200, coverNaturalWidth: 0, coverComplete: false },
    { coverSrc: 'blob:https://x.com/cover', coverWidth: 200 },
    { coverTagName: 'VIDEO', coverWidth: 200 },
    { coverWidth: 32, coverNaturalWidth: 200, coverComplete: true }]) {
    const f = fixture({ cover: true, ...options });
    assert.equal((await runClock(t, () => setArticleCover(f.browser, '123', args))).replaced, true);
  }
});

test('missing article lookup fails fast for cover, publish, delete and draft creation', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  const actions = [browser => setArticleCover(browser, '123', args), browser => publishArticle(browser, '123'),
    browser => deleteArticleDraft(browser, '123'), browser => createArticleDraft(browser, args)];
  const keys = ['articleEntityId', 'article_id', 'articleId', 'rest_id'];
  for (const [index, action] of actions.entries()) for (const method of ['GET', 'POST']) {
    for (const article of [{ result: {} }, { result: null }, {}]) {
      const f = fixture({ editorMissing: true, articleLookup: { method, delay: 500,
        variables: { [keys[index]]: '123' }, body: { data: { article_result_by_rest_id: article } } } });
      await runClock(t, async () => {
        const start = Date.now();
        await assert.rejects(action(f.browser), error => {
          assert.equal(error.code, 'INVALID_INPUT');
          assert.equal(error.message, '文章草稿不存在或无法打开。');
          assert.equal(error.details.article_id, '123');
          assert.equal(error.details.edit_url, 'https://x.com/compose/articles/edit/123');
          return true;
        });
        assert.ok(Date.now() - start < 3000);
        assert.ok(Date.now() - f.calls.find(call => call[0] === 'articleResponse')[1] <= 1000);
      });
      assert.equal(f.calls.some(call => call[0] === 'files' || call[0] === 'click' && call[1] !== 'create'), false);
      assert.equal(f.listenerCount(), 0);
      assert.equal(f.state.closed, true);
    }
  }
});

test('unrelated, real and failed article lookups leave a loading editor to its existing timeout', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  const empty = { data: { article_result_by_rest_id: { result: {} } } };
  for (const lookup of [
    { variables: { rest_id: '999' }, body: empty },
    { body: { data: { article_result_by_rest_id: { result: { content_state: {}, cover_media: {} } } } } },
    { body: { errors: [{ message: 'denied' }] } },
    { body: empty, status: 500 },
    { variables: {}, body: empty },
  ]) {
    const f = fixture({ editorMissing: true, articleLookup: { variables: { rest_id: '123' }, ...lookup } });
    await runClock(t, async () => {
      const start = Date.now();
      await assert.rejects(setArticleCover(f.browser, '123', args), error => error.code === 'UI_CHANGED');
      assert.equal(Date.now() - start, 30000);
    });
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.state.closed, true);
  }
});

test('GET article lookup preserves a nineteen-digit id from URL variables', async t => {
  const id = '1234567890123456789';
  const f = fixture({ editorMissing: true, articleLookup: { variables: { rest_id: id },
    body: { data: { article_result_by_rest_id: { result: {} } } } } });
  const args = await input(t, { cover: '/tmp/cover.png' });
  await runClock(t, async () => {
    const start = Date.now();
    await assert.rejects(setArticleCover(f.browser, id, args), error => {
      assert.equal(error.code, 'INVALID_INPUT');
      assert.equal(error.details.article_id, id);
      assert.equal(error.details.edit_url, `https://x.com/compose/articles/edit/${id}`);
      return true;
    });
    assert.ok(Date.now() - start < 3000);
  });
});

test('real article lookup permits a slow editor to finish loading', async t => {
  const f = fixture({ editorMissing: true, articleLookup: { variables: { rest_id: '123' },
    body: { data: { article_result_by_rest_id: { result: { content_state: {}, cover_media: {} } } } } } });
  const args = await input(t, { cover: '/tmp/cover.png' });
  await runClock(t, async () => {
    setTimeout(() => { f.state.editorMissing = false; }, 5000);
    assert.equal((await setArticleCover(f.browser, '123', args)).cover, true);
  });
});

test('login, challenge and published detection retain priority over missing article lookup', async t => {
  const args = await input(t, { cover: '/tmp/cover.png' });
  for (const [options, code, message] of [
    [{ redirect: '/i/flow/login' }, 'NOT_LOGGED_IN', /登录/],
    [{ redirect: '/account/access' }, 'ACCOUNT_CHALLENGE', /验证/],
    [{ published: true }, 'INVALID_INPUT', /该文章已发布/],
  ]) {
    const f = fixture({ ...options, articleLookup: { variables: { rest_id: '123' },
      body: { data: { article_result_by_rest_id: { result: {} } } } } });
    await runClock(t, async () => {
      const start = Date.now();
      await assert.rejects(setArticleCover(f.browser, '123', args), error => error.code === code && message.test(error.message));
      assert.equal(Date.now() - start, 0);
    });
    assert.equal(f.listenerCount(), 0);
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function jobClock(t, promise, { waitForLock = false } = {}) {
  let outcome;
  let browserStarted = !waitForLock;
  promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  const deadline = performance.now() + 2000;
  while (!outcome) {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(performance.now() < deadline, 'job did not settle within 2 seconds');
    if (holdsLock(join(config.home, 'browser.lock'))) browserStarted = true;
    if (!outcome && browserStarted) t.mock.timers.tick(250);
  }
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

async function pausedDraft(t, { beforeId = false } = {}) {
  const f = await toolFixture(t);
  config.toolWaitSec = 45;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entered = deferred();
  const gate = deferred();
  const original = f.page.insertText;
  if (beforeId) {
    t.mock.method(Browser, 'open', async () => {
      entered.resolve();
      await gate.promise;
      return { isLoggedIn: async () => true, newPage: async () => f.page, close: async () => {} };
    });
  } else {
    t.mock.method(f.page, 'insertText', async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
  }
  const draft = callTool('x_article_draft', { markdown_path: f.markdown_path });
  await entered.promise;
  t.mock.timers.tick(45000);
  const progress = await draft;
  const data = JSON.parse(progress.content[0].text);
  t.after(async () => { gate.resolve(); await jobClock(t, pendingWork()); });
  return { ...f, gate, progress, data };
}

test('fast MCP draft returns its final shape, UUID and image, with idempotent status', async t => {
  const f = await toolFixture(t);
  config.toolWaitSec = 45;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const result = await jobClock(t, callTool('x_article_draft', { markdown_path: f.markdown_path }));
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(data.status, undefined);
  assert.match(data.job_id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.equal(data.article_id, '123');
  assert.equal(data.title, 'Title');
  assert.equal(data.text_chars_inserted, 2);
  assert.equal(data.text_chars_expected, 2);
  assert.deepEqual(data.warnings, []);
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].data, Buffer.from('mock PNG').toString('base64'));
  assert.deepEqual(await callTool('x_job_status', { job_id: data.job_id }), result);
  assert.deepEqual(await callTool('x_article_status', { job_id: data.job_id }), result);
  assert.deepEqual(await callTool('x_article_status', { job_id: data.job_id.toUpperCase() }), result);
  assert.equal(f.opened.mock.callCount(), 1);
});

test('slow draft exposes its id, repeated status waits, and later returns the final image', async t => {
  const f = await pausedDraft(t);
  assert.equal(f.progress.isError, undefined);
  assert.equal(f.data.ok, true);
  assert.equal(f.data.status, 'in_progress');
  assert.equal(f.data.waiting_for_browser, false);
  assert.equal(f.data.article_id, '123');
  assert.equal(f.data.edit_url, 'https://x.com/compose/articles/edit/123');
  assert.equal(f.data.elapsed_sec, 45);
  assert.match(f.data.next_step, /job_id.*x_job_status.*不要再次调用 x_article_draft.*重复草稿/);
  assert.equal(f.progress.content.length, 1);
  const poll = callTool('x_article_status', { job_id: f.data.job_id });
  t.mock.timers.tick(45000);
  assert.equal(JSON.parse((await poll).content[0].text).status, 'in_progress');
  assert.equal(f.state.browserClosed, undefined);
  f.gate.resolve();
  const result = await jobClock(t, callTool('x_article_status', { job_id: f.data.job_id }));
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, undefined);
  assert.equal(data.job_id, f.data.job_id);
  assert.equal(data.images_inserted, 0);
  assert.equal(result.content[1].type, 'image');
  assert.equal(f.state.browserClosed, true);
  assert.equal(f.opened.mock.callCount(), 1);
});

test('draft can time out before its id is known and status preserves a late XPosterError exactly', async t => {
  const f = await pausedDraft(t, { beforeId: true });
  assert.equal(f.data.status, 'in_progress');
  assert.equal(f.data.article_id, undefined);
  assert.equal(f.data.edit_url, undefined);
  const failure = new XPosterError('UNCERTAIN', '无法确认草稿。', {
    hint: '不要重试。', article_id: '123', edit_url: 'https://x.com/compose/articles/edit/123',
  });
  f.gate.reject(failure);
  const result = await callTool('x_article_status', { job_id: f.data.job_id });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, ...failure.toJSON() });
  assert.deepEqual(await callTool('x_article_status', { job_id: f.data.job_id }), result);
});

test('unknown UUID and invalid status inputs fail without browser work', async t => {
  const f = await toolFixture(t);
  for (const args of [undefined, null, [], {}, { job_id: 123 }, { job_id: '123' },
    { job_id: '00000000-0000-0000-0000-000000000000\n' },
    { job_id: '00000000-0000-0000-0000-000000000000', extra: true }]) {
    const result = await callTool('x_article_status', args);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'INVALID_INPUT');
  }
  const unknown = await callTool('x_article_status', { job_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(JSON.parse(unknown.content[0].text).code, 'INVALID_INPUT');
  assert.match(JSON.parse(unknown.content[0].text).hint, /https:\/\/x.com\/compose\/articles.*不要盲目/);
  assert.equal(f.opened.mock.callCount(), 0);
});

test('finished jobs expire one hour after completion, pending jobs are retained', async t => {
  const f = await pausedDraft(t, { beforeId: true });
  t.mock.timers.tick(3600000);
  const running = callTool('x_article_status', { job_id: f.data.job_id });
  t.mock.timers.tick(45000);
  assert.equal(JSON.parse((await running).content[0].text).status, 'in_progress');
  f.gate.resolve();
  const done = await jobClock(t, callTool('x_article_status', { job_id: f.data.job_id }));
  assert.equal(done.isError, undefined);
  t.mock.timers.tick(3599999);
  assert.deepEqual(await callTool('x_article_status', { job_id: f.data.job_id }), done);
  t.mock.timers.tick(1);
  const expired = await callTool('x_article_status', { job_id: f.data.job_id });
  assert.equal(expired.isError, true);
  assert.equal(JSON.parse(expired.content[0].text).code, 'INVALID_INPUT');
  assert.match(JSON.parse(expired.content[0].text).hint, /不要盲目/);
});

test('MCP draft validation returns immediately without starting browser work or a job timer', async t => {
  const f = await toolFixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (const args of [{}, { markdown_path: 'relative.md' }, { markdown_path: f.markdown_path, title: '' },
    { markdown_path: join(f.dir, 'missing.md') }, { markdown_path: f.markdown_path, extra: true }]) {
    const result = await callTool('x_article_draft', args);
    assert.equal(result.isError, true);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.code, 'INVALID_INPUT');
    assert.equal(data.job_id, undefined);
  }
  assert.equal(f.opened.mock.callCount(), 0);
  await pendingWork();
});

test('CLI draft entry waits past the MCP deadline and returns only the final result', async t => {
  const f = await toolFixture(t);
  config.toolWaitSec = 5;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const gate = deferred();
  const entered = deferred();
  const original = f.page.insertText;
  t.mock.method(f.page, 'insertText', async (...args) => {
    entered.resolve();
    await gate.promise;
    return original(...args);
  });
  let returned = false;
  const draft = articleDraft({ markdown_path: f.markdown_path }).then(result => { returned = true; return result; });
  await entered.promise;
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(returned, false);
  gate.resolve();
  const result = await jobClock(t, draft);
  assert.equal(result.data.article_id, '123');
  assert.equal(result.data.status, undefined);
  assert.equal(result.data.job_id, undefined);
  assert.ok(Buffer.isBuffer(result.image));
});


test('empty and whitespace-only text segments paste once without gain checks or retries', async t => {
  const f = fixture();
  const args = await input(t, { segments: [
    { type: 'images', paths: ['/tmp/one.png'] },
    { type: 'html', html: '<p><br></p>', text: '' },
    { type: 'html', html: '<p> </p>', text: ' \n' },
    { type: 'images', paths: ['/tmp/two.png'] },
  ] });
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.deepEqual(f.calls.filter(call => call[0] === 'paste').map(call => call[1]), ['', ' \n']);
  assert.equal(result.text_chars_expected, 0);
  assert.equal(result.text_chars_inserted, 0);
  assert.equal(result.images_inserted, 2);
});


test('article jobs wait beyond the synchronous limit and expose browser waiting status', async t => {
  const f = await toolFixture(t);
  config.busyWaitSec = 1;
  config.toolWaitSec = 0.01;
  const entered = deferred();
  const gate = deferred();
  const blocker = exclusive(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const draft = await jobClock(t, callTool('x_article_draft', { markdown_path: f.markdown_path }));
    const data = JSON.parse(draft.content[0].text);
    assert.equal(data.status, 'in_progress');
    assert.equal(data.waiting_for_browser, true);
    const synchronous = await jobClock(t, callTool('x_status', {}));
    assert.equal(JSON.parse(synchronous.content[0].text).code, 'BUSY');
    const poll = JSON.parse((await jobClock(t, callTool('x_article_status', { job_id: data.job_id }))).content[0].text);
    assert.equal(poll.status, 'in_progress');
    assert.equal(poll.waiting_for_browser, true);
    assert.equal(f.opened.mock.callCount(), 0);
    config.toolWaitSec = 45;
    gate.resolve();
    await jobClock(t, pendingWork());
    const done = JSON.parse((await callTool('x_article_status', { job_id: data.job_id })).content[0].text);
    assert.equal(done.article_id, '123');
    assert.equal(done.status, undefined);
    assert.equal(f.opened.mock.callCount(), 1);
  } finally { gate.resolve(); await blocker; }
});

test('article browser wait ends with BUSY after fifteen simulated minutes without creating a draft', async t => {
  const f = await toolFixture(t);
  config.toolWaitSec = 0.01;
  const entered = deferred();
  const gate = deferred();
  const blocker = exclusive(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const result = await jobClock(t, callTool('x_article_draft', { markdown_path: f.markdown_path }));
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.waiting_for_browser, true);
    t.mock.timers.tick(15 * 60 * 1000);
    const final = await jobClock(t, callTool('x_article_status', { job_id: data.job_id }));
    assert.equal(final.isError, true);
    assert.equal(JSON.parse(final.content[0].text).code, 'BUSY');
    assert.equal(f.opened.mock.callCount(), 0);
  } finally { gate.resolve(); await blocker; await pendingWork(); }
  assert.equal(f.opened.mock.callCount(), 0);
});


test('all article editor and list navigations recover rendering before inspecting the UI', async t => {
  const draftInput = await input(t);
  for (const action of [
    f => createArticleDraft(f.browser, draftInput),
    f => setArticleCover(f.browser, '123', { cover: '/tmp/cover.png', screenshotPath: draftInput.screenshotPath }),
    f => publishArticle(f.browser, '123'),
    f => deleteArticleDraft(f.browser, '123'),
  ]) {
    const f = fixture();
    await runClock(t, () => action(f));
    const navigations = f.calls.flatMap((call, index) => call[0] === 'navigate' ? [index] : []);
    assert.ok(navigations.length > 0);
    for (const index of navigations) assert.equal(f.calls[index + 1][0], 'ensureRendering');
  }
});
