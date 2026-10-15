import nodeTest from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createArticleDraft, setArticleCover, publishArticle, deleteArticleDraft, ARTICLE_SELECTORS as S } from '../server/article.mjs';
import { Browser } from '../server/chrome.mjs';
import { XPosterError } from '../server/errors.mjs';
import { config } from '../server/config.mjs';
import { articleDraft, articleCover, articlePublish, articleDelete, callTool } from '../server/tools.mjs';
import { readHistory, checkRateLimit } from '../server/limits.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);

function fixture(options = {}) {
  const state = { pathname: '/compose/articles', title: '', text: '', images: 0, cover: false, dialog: null,
    menu: false, saved: '上一次保存 初始', create: true, imagePolls: 0, rectReads: {},
    processingText: '', cancelUpload: false, processingIndex: 0, ...options };
  const calls = [];
  const handlers = new Map();
  const bodies = new Map();
  const tagged = new Map();
  let requestNumber = 0;
  const emit = (method, value) => { for (const fn of handlers.get(method) ?? []) fn(value); };
  const response = (operation, body = { data: { ok: true } }, variables = { articleEntityId: '123' }, status = 200) => {
    const requestId = String(++requestNumber);
    const url = `https://x.com/i/api/graphql/hash/${operation}`;
    emit('Network.requestWillBeSent', { requestId, request: { url, method: 'POST', postData: JSON.stringify({ variables }) } });
    bodies.set(requestId, body);
    emit('Network.responseReceived', { requestId, response: { url, status } });
    emit('Network.loadingFinished', { requestId });
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
  Object.defineProperty(composer, 'innerText', { get: () => state.text });
  Object.defineProperty(composer, 'textContent', { get: () => state.text });
  composer.querySelectorAll = selector => Array(selector === 'img' || selector === S.removeMedia ? state.images : 0).fill({});
  composer.dispatchEvent = event => {
    if (!state.ignorePaste) state.text += event.clipboardData.values['text/plain'];
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
  coverMedia.tagName = 'IMG';
  Object.defineProperties(coverMedia, {
    complete: { get: () => state.coverComplete ?? Date.now() >= (state.coverReadyAt ?? 0) },
    naturalWidth: { get: () => state.coverNaturalWidth ?? 1200 },
  });
  coverMedia.getBoundingClientRect = () => ({ width: state.coverWidth ?? 1200 });
  const extraCoverImages = (state.extraCoverImages ?? []).map(scope => ({
    tagName: 'IMG', complete: true, naturalWidth: 1200,
    getBoundingClientRect: () => ({ width: scope === 'thumbnail' ? 32 : 1200 }),
    closest: selector => scope === 'body' && selector === S.composer ? composer
      : scope === 'dialog' && selector === S.dialog ? dialog : null,
  }));
  coverMedia.closest = selector => state.mediaInBody && selector === S.composer ? composer
    : state.mediaInDialog && selector === S.dialog ? dialog : null;
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
      if (selector === S.mediaInput) return state.dialog === 'media' ? element('mediaInput') : null;
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
    async navigate(url) { calls.push(['navigate', url]); state.pathname = state.redirect ?? new URL(url).pathname; if (state.pathname.includes('/edit/')) state.title ||= 'Existing'; if (state.oldCoverResponse) response('ArticleEntityUpdateCoverMedia'); },
    async call(fn, ...args) {
      return runInNewContext(`(${fn.toString()})(...args)`, { args, document, location: state, DataTransfer, ClipboardEvent,
        window: { scrollTo(...args) { calls.push(['scroll', ...args]); } }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 } });
    },
    async waitFor(fn, args = [], waitOptions = {}) {
      calls.push(['waitFor', waitOptions.timeout]);
      for (let i = 0; i < 3; i++) {
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
      }
      return null;
    },
    async click(selector) {
      const kind = tagged.get(selector)?.kind ?? ({ [S.create]: 'create', [S.insert]: 'insert', [S.confirm]: 'confirm', [S.cover]: 'coverButton' })[selector];
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
      if (kind === 'create') { state.pathname = '/compose/articles/edit/123'; state.title = ''; }
      if (kind === 'insert' || kind === 'more') state.menu = true;
      if (kind === 'media') { state.menu = false; state.dialog = 'media'; }
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
        if (!state.noSave) {
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
    async press(key) { calls.push(['press', key]); if (key === 'Escape') state.menu = false; },
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
    async screenshot() { calls.push(['screenshot', Date.now()]); return Buffer.from('mock PNG'); },
    async close() { state.closed = true; },
  };
  return { page, browser: { newPage: async () => page }, state, calls, response,
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0) };
}

const clockTimes = new WeakMap();
async function runClock(t, action) {
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
      if (!outcome) t.mock.timers.runAll();
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    clockTimes.set(t, Date.now());
    t.mock.timers.reset();
  }
}

async function input(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-article-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { title: '新文章', segments: [{ type: 'html', html: '<p>正文</p>', text: '正文' }], screenshotPath: join(dir, 'preview.png'), ...extra };
}

test('draft creates a new id, pastes rich HTML, awaits save and returns a screenshot', async t => {
  const f = fixture();
  const args = await input(t);
  const result = await runClock(t, () => createArticleDraft(f.browser, args));
  assert.equal(result.article_id, '123');
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
  const result = await runClock(t, () => callTool('x_article_draft', { markdown_path: f.markdown_path, title: 'Override' }));
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
  const result = await runClock(t, () => articlePublish({ article_id: '123' }));
  assert.equal(result.data.article_id, '123');
  const history = await readHistory(config.historyFile);
  assert.deepEqual(Object.keys(history[0]).sort(), ['article_id', 'ts', 'url']);
  assert.equal(history[0].article_id, '123');
  await assert.rejects(articlePublish({ article_id: '123' }), error => error.code === 'RATE_LIMITED');
  assert.equal(f.opened.mock.callCount(), 1);
  await runClock(t, () => articleDelete({ article_id: '123' }));
  const after = await readHistory(config.historyFile);
  assert.equal(after[1].deleted_article, '123');
  const limits = { now: Date.now(), minIntervalSec: 60, dailyLimit: 20 };
  assert.deepEqual(checkRateLimit(after, limits), checkRateLimit(history, limits));
});

test('uncertain article publication is counted once and not retried', async t => {
  const f = await toolFixture(t, { noPublish: true });
  const result = await runClock(t, () => callTool('x_article_publish', { article_id: '123' }));
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
  await assert.rejects(runClock(t, () => articleDelete({ article_id: '123' })), error => error.code === 'UNCERTAIN' && /历史记录/.test(error.message));
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
  const result = await runClock(t, () => callTool('x_article_cover', { article_id: '123', cover }));
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
  const result = await runClock(t, () => articleCover({ article_id: '123', cover: `~/${relative(homedir(), cover)}` }));
  assert.equal(result.data.cover, true);
  assert.deepEqual(f.calls.find(call => call[0] === 'files')[2], [cover]);
});

test('uncertain cover MCP and screenshot failures keep history unchanged and include the draft id', async t => {
  const f = await toolFixture(t, { noSave: true });
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  const result = await runClock(t, () => callTool('x_article_cover', { article_id: '123', cover }));
  assert.equal(result.isError, true);
  const failure = JSON.parse(result.content[0].text);
  assert.equal(failure.code, 'UNCERTAIN');
  assert.equal(failure.article_id, '123');
  assert.equal(failure.edit_url, 'https://x.com/compose/articles/edit/123');
  assert.deepEqual(await readHistory(config.historyFile), []);
  assert.equal(f.state.browserClosed, true);
  const direct = fixture();
  await assert.rejects(runClock(t, () => setArticleCover(direct.browser, '123', { cover, screenshotPath: f.dir })),
    error => error.code === 'UNCERTAIN' && error.details.article_id === '123');
  assert.equal(direct.state.closed, true);
  assert.equal(direct.listenerCount(), 0);
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
  const cover = join(f.dir, 'cover.png');
  await writeFile(cover, 'image');
  for (const [tool, args] of [['x_article_cover', { article_id: '123', cover }],
    ['x_article_draft', { markdown_path: f.markdown_path, cover }]]) {
    const result = await runClock(t, () => callTool(tool, args));
    assert.equal(result.isError, undefined);
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
