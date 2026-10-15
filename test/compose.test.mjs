import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, SELECTORS } from '../server/x.mjs';

function fixture(options = {}) {
  const state = {
    text: '', paste: true, modal: true, attachments: false, attachFiles: true,
    pathname: '/compose/post', toast: null, toastHref: null,
    body: JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '123' } } } } }),
    base64: false, ...options,
  };
  const calls = [];
  const scope = state.modal ? `${SELECTORS.dialog} ` : '';
  const editor = {
    get textContent() { return state.text; }, get innerText() { return state.text; },
    focus() {}, querySelector() { return null; },
    dispatchEvent(event) { if (state.paste) state.text += event.clipboardData.value; },
    parentElement: { contains: () => true,
      getBoundingClientRect: () => ({ x: 20, y: 30, right: 420, bottom: 330, width: 400, height: 300 }) },
    contains: () => false,
  };
  const inlineEditor = { textContent: 'timeline draft', innerText: 'timeline draft' };
  const button = { disabled: false, getAttribute: () => 'false' };
  const attachment = { innerText: '', querySelector: () => null };
  const document = {
    querySelector(selector) {
      if (selector === scope + SELECTORS.editor) return editor;
      if (selector === SELECTORS.editor) return inlineEditor;
      if (selector === scope + SELECTORS.postButton) return button;
      if (selector === SELECTORS.profileLink) return { getAttribute: () => '/alice' };
      if (selector === SELECTORS.toast && state.toast) return {
        innerText: state.toast, querySelector: () => state.toastHref ? { getAttribute: () => state.toastHref } : null,
      };
      return null;
    },
    querySelectorAll(selector) { return selector === scope + SELECTORS.attachments && state.attachments ? [attachment] : []; },
  };
  class DataTransfer {
    setData(type, value) { this.value = value; }
  }
  class ClipboardEvent {
    constructor(type, options) { Object.assign(this, options); }
  }
  const events = new Map();
  const page = {
    closed: false,
    async navigate(url) { calls.push(['navigate', url]); },
    async call(fn, ...args) {
      calls.push(['call', args]);
      return runInNewContext(`(${fn.toString()})(...args)`, {
        args, document, location: state, DataTransfer, ClipboardEvent, scrollX: 0, scrollY: 0,
      });
    },
    async waitFor(fn, args = []) { return this.call(fn, ...args); },
    async press(key) {
      calls.push(['press', key]);
      if (key === 'Backspace') state.text = '';
      if (key === 'Enter') state.text += '\n';
    },
    async insertText(text) { state.text += text; },
    async setFiles(selector, files) {
      calls.push(['files', selector, files]);
      state.attachments = state.attachFiles;
    },
    async screenshot(clip) { calls.push(['screenshot', clip]); return Buffer.from('mock PNG'); },
    async send(method) {
      calls.push(['send', method]);
      return { body: state.base64 ? Buffer.from(state.body).toString('base64') : state.body, base64Encoded: state.base64 };
    },
    on(method, handler) { events.set(method, handler); return () => events.delete(method); },
    async click(selector) {
      calls.push(['click', selector]);
      events.get('Network.responseReceived')?.({ requestId: 'request', response: { url: 'https://x.com/i/api/graphql/hash/CreateTweet' } });
      events.get('Network.loadingFinished')?.({ requestId: 'request' });
    },
    async close() { this.closed = true; },
  };
  return { browser: { newPage: async () => page }, page, state, calls, events, inlineEditor };
}

async function input(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-compose-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { text: 'hello\n你好 🚀', images: [], submit: false, screenshotPath: join(dir, 'preview.png'), weightedLength: 13, ...overrides };
}

test('preview scopes the modal, falls back to trusted multiline text and never submits', async t => {
  const { browser, page, state, calls, inlineEditor } = fixture({ paste: false, text: 'old draft' });
  const args = await input(t, { images: ['/tmp/one.png', '/tmp/two.png'] });
  const result = await compose(browser, args);
  assert.equal(state.text, args.text);
  assert.equal(inlineEditor.textContent, 'timeline draft');
  assert.deepEqual(calls.find(call => call[0] === 'files'), ['files', `${SELECTORS.dialog} ${SELECTORS.fileInput}`, args.images]);
  assert.equal(calls.some(call => call[0] === 'click' || call[0] === 'send'), false);
  assert.equal(result.username, 'alice');
  assert.deepEqual(await readFile(args.screenshotPath), result.screenshot);
  assert.equal(page.closed, true);
});

test('confirmed network body returns the post id and removes response listeners', async t => {
  const { browser, page, calls, events } = fixture({ base64: true });
  const result = await compose(browser, await input(t, { submit: true }));
  assert.equal(result.id, '123');
  assert.equal(result.username, 'alice');
  assert.deepEqual(calls.find(call => call[0] === 'click'), ['click', `${SELECTORS.dialog} ${SELECTORS.postButton}`]);
  assert.ok(calls.some(call => call[1] === 'Network.getResponseBody'));
  assert.equal(events.size, 0);
  assert.equal(page.closed, true);
});

test('X duplicate rejection is preserved with the Chinese hint', async t => {
  const { browser, page } = fixture({ body: JSON.stringify({ errors: [{ code: 187, message: 'duplicate' }] }) });
  await assert.rejects(compose(browser, await input(t, { submit: true })), error => {
    assert.equal(error.code, 'POST_REJECTED');
    assert.deepEqual(error.toJSON().x_error_codes, [187]);
    assert.match(error.hint, /重复/);
    return true;
  });
  assert.equal(page.closed, true);
});

test('unparseable response uses only a status link in the toast as success', async t => {
  const { browser } = fixture({ body: 'not JSON', toast: '已发送', toastHref: '/alice/status/456' });
  assert.equal((await compose(browser, await input(t, { submit: true }))).id, '456');
  const unknown = fixture({ body: '{}', toast: '正在发送' });
  await assert.rejects(compose(unknown.browser, await input(t, { submit: true })), error => {
    assert.equal(error.code, 'UNCERTAIN');
    assert.match(error.hint, /不要自动重试/);
    return true;
  });
  assert.equal(unknown.page.closed, true);
});

test('login and account challenges are returned without filling or clicking', async t => {
  for (const [pathname, code] of [['/i/flow/login', 'NOT_LOGGED_IN'], ['/account/access', 'ACCOUNT_CHALLENGE']]) {
    const { browser, page, calls } = fixture({ pathname });
    await assert.rejects(compose(browser, await input(t, { submit: true })), error => error.code === code);
    assert.equal(calls.some(call => call[0] === 'click' || call[0] === 'files'), false);
    assert.equal(page.closed, true);
  }
});

test('enabled button without attachments never publishes an image post', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now += 11000);
  const { browser, page, calls } = fixture({ attachFiles: false });
  await assert.rejects(compose(browser, await input(t, { submit: true, images: ['/tmp/image.png'] })), error => {
    assert.equal(error.code, 'UI_CHANGED');
    assert.equal(error.toJSON().selector, `${SELECTORS.dialog} ${SELECTORS.attachments}`);
    return true;
  });
  assert.equal(calls.some(call => call[0] === 'click'), false);
  assert.equal(page.closed, true);
});
