import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, listScheduled, SELECTORS } from '../server/x.mjs';

function fixture(options = {}) {
  const state = {
    text: '', paste: true, modal: true, attachments: false, attachFiles: true,
    pathname: '/compose/post', toast: null, toastHref: null,
    body: JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '123' } } } } }),
    base64: false, scheduling: false, scheduleDialog: false, empty: false, ...options,
  };
  const calls = [];
  const scope = state.modal ? `${SELECTORS.dialog} ` : '';
  const editor = {
    get textContent() { return state.text; }, get innerText() { return state.text; },
    focus() {}, querySelector() { return null; },
    dispatchEvent(event) { if (state.paste) state.text += event.clipboardData.value; },
    parentElement: { contains: () => true,
      getBoundingClientRect: () => ({ x: 20, y: 30, right: 420, bottom: 330, width: 400, height: 300 }) },
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    contains: () => false,
  };
  const inlineEditor = { textContent: 'timeline draft', innerText: 'timeline draft' };
  const button = { disabled: false, getAttribute: () => 'false' };
  const attachment = { innerText: '', querySelector: () => null };
  class Select {
    constructor(values) { this.options = values.map(value => ({ value, text: value })); this.current = ''; }
    get value() { return this.current; }
    set value(value) { this.current = this.options.some(option => option.value === value) ? value : ''; }
    dispatchEvent(event) { calls.push(['event', event.type, this.value]); }
  }
  const range = (first, last) => ['', ...Array.from({ length: last - first + 1 }, (_, i) => String(first + i))];
  const selects = (state.selectValues ?? [range(1, 12), range(1, 31), ['', '2028', '2027', '2026'], range(0, 23), range(0, 59)])
    .map(values => new Select(values));
  const scheduleDialog = { querySelectorAll: () => selects };
  const document = {
    querySelector(selector) {
      if (selector === SELECTORS.scheduleConfirm && state.scheduleDialog) return button;
      if (selector === '[data-testid=emptyState]' && state.empty) return {};
      if (selector === scope + SELECTORS.editor) return editor;
      if (selector === SELECTORS.editor) return inlineEditor;
      if (selector === scope + SELECTORS.postButton) return button;
      if (selector === SELECTORS.profileLink) return { getAttribute: () => '/alice' };
      if (selector === SELECTORS.toast && state.toast) return {
        innerText: state.toast, querySelector: () => state.toastHref ? { getAttribute: () => state.toastHref } : null,
      };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === SELECTORS.dialog) return state.scheduleDialog ? [{}, scheduleDialog] : [{}];
      return selector === scope + SELECTORS.attachments && state.attachments ? [attachment] : []; },
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
    async navigate(url) {
      calls.push(['navigate', url]);
      if (state.listResponse) {
        events.get('Network.responseReceived')?.({ requestId: 'request', response: { url: 'https://x.com/i/api/graphql/hash/FetchScheduledTweets' } });
        events.get('Network.loadingFinished')?.({ requestId: 'request' });
      }
    },
    async call(fn, ...args) {
      calls.push(['call', args]);
      return runInNewContext(`(${fn.toString()})(...args)`, {
        args, document, location: state, DataTransfer, ClipboardEvent, HTMLSelectElement: Select, Event, scrollX: 0, scrollY: 0,
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
      if (selector.endsWith(SELECTORS.scheduleButton)) { state.scheduleDialog = true; return; }
      if (selector === SELECTORS.scheduleConfirm) { state.scheduleDialog = false; return; }
      state.onSubmit?.();
      if (state.clickError) throw state.clickError;
      if (state.noResponse) return;
      const operation = state.scheduling ? 'CreateScheduledTweet' : 'CreateTweet';
      events.get('Network.responseReceived')?.({ requestId: 'request', response: { url: `https://x.com/i/api/graphql/hash/${operation}` } });
      events.get('Network.loadingFinished')?.({ requestId: 'request' });
    },
    async close() { this.closed = true; },
  };
  return { browser: { newPage: async () => page }, page, state, calls, events, inlineEditor, selects };
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


const scheduledAt = { year: 2026, month: 10, day: 16, hour: 0, minute: 7 };
test('scheduled preview sets and verifies native selects, confirms the dialog and never submits', async t => {
  const { browser, page, calls, selects } = fixture();
  await compose(browser, await input(t, { mode: 'preview', scheduledAt }));
  assert.deepEqual(selects.map(select => select.value), ['10', '16', '2026', '0', '7']);
  assert.deepEqual(calls.filter(call => call[0] === 'click').map(call => call[1]),
    [`${SELECTORS.dialog} ${SELECTORS.scheduleButton}`, SELECTORS.scheduleConfirm]);
  assert.ok(calls.some(call => call[0] === 'event' && call[1] === 'change'));
  assert.ok(calls.some(call => call[0] === 'event' && call[1] === 'input'));
  assert.equal(calls.some(call => call[0] === 'send'), false);
  assert.equal(page.closed, true);
});

test('12-hour schedule sets midnight, noon and afternoon with AM/PM', async t => {
  const range = (first, last) => ['', ...Array.from({ length: last - first + 1 }, (_, i) => String(first + i))];
  for (const [hour, expectedHour, period] of [[0, '12', 'AM'], [12, '12', 'PM'], [17, '5', 'PM']]) {
    const { browser, selects } = fixture({ selectValues: [range(1, 12), range(1, 31), ['', '2026'], range(1, 12), range(0, 59), ['', 'AM', 'PM']] });
    await compose(browser, await input(t, { mode: 'preview', scheduledAt: { ...scheduledAt, hour } }));
    assert.equal(selects[3].value, expectedHour);
    assert.equal(selects[5].value, period);
  }
});

test('missing schedule year and unknown controls stop before submission', async t => {
  for (const [selectValues, code] of [
    [[['1', '2']], 'UI_CHANGED'],
    [undefined, 'INVALID_INPUT'],
  ]) {
    const { browser, page, calls } = fixture({ ...(selectValues ? { selectValues } : {}) });
    await assert.rejects(compose(browser, await input(t, { mode: 'schedule', scheduledAt: { ...scheduledAt, year: 2029 } })), error => error.code === code);
    assert.equal(calls.some(call => call[0] === 'click' && call[1].endsWith(SELECTORS.postButton)), false);
    assert.equal(page.closed, true);
  }
});

test('schedule success, rejection and missing ids all clean response watchers', async t => {
  for (const [body, code] of [
    ['{"data":{"create":{"scheduled_tweet_id":"987"}}}', null],
    ['{"errors":[{"message":"denied","code":226}]}', 'POST_REJECTED'],
    ['{}', 'UNCERTAIN'], ['not JSON', 'UNCERTAIN'],
  ]) {
    const { browser, page, calls, events } = fixture({ scheduling: true, body, base64: true, toastHref: '/alice/status/123' });
    const action = compose(browser, await input(t, { mode: 'schedule', scheduledAt }));
    if (code) await assert.rejects(action, error => error.code === code && (code !== 'UNCERTAIN' || /预排期.*不要|不要.*预排期/.test(error.hint)));
    else assert.equal((await action).id, '987');
    assert.equal(calls.filter(call => call[0] === 'click' && call[1].endsWith(SELECTORS.postButton)).length, 1);
    assert.equal(events.size, 0);
    assert.equal(page.closed, true);
  }
});

test('list captures a response emitted during navigation and closes its page', async () => {
  const { browser, page, calls, events } = fixture({ listResponse: true, body: '{"data":{"scheduled":[{"id":"123","execute_at":1792112400,"text":"hello"}]}}' });
  const result = await listScheduled(browser);
  assert.equal(result[0].id, '123');
  assert.ok(calls.findIndex(call => call[1] === 'Network.enable') < calls.findIndex(call => call[0] === 'navigate'));
  assert.equal(page.closed, true);
  assert.equal(events.size, 0);
});

test('list timeout returns empty only for an observed empty state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const empty of [true, false]) {
    const { browser, page, events } = fixture({ empty });
    const action = listScheduled(browser);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    t.mock.timers.tick(30000);
    if (empty) assert.deepEqual(await action, []);
    else await assert.rejects(action, error => error.code === 'UI_CHANGED');
    assert.equal(page.closed, true);
    assert.equal(events.size, 0);
  }
});


test('schedule response timeout is UNCERTAIN and never repeats the click', async t => {
  let submitted;
  const clicked = new Promise(resolve => { submitted = resolve; });
  const { browser, page, calls, events } = fixture({ noResponse: true, onSubmit: submitted });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = compose(browser, await input(t, { mode: 'schedule', scheduledAt }));
  await clicked;
  const rejected = assert.rejects(action, error => error.code === 'UNCERTAIN' && /不要自动重试/.test(error.hint));
  t.mock.timers.tick(60000);
  await rejected;
  assert.equal(calls.filter(call => call[0] === 'click' && call[1].endsWith(SELECTORS.postButton)).length, 1);
  assert.equal(events.size, 0);
  assert.equal(page.closed, true);
});

test('schedule click transport failure remains UNCERTAIN and closes its page', async t => {
  const { browser, page, events } = fixture({ clickError: new Error('transport closed') });
  await assert.rejects(compose(browser, await input(t, { mode: 'schedule', scheduledAt })), error => error.code === 'UNCERTAIN');
  assert.equal(events.size, 0);
  assert.equal(page.closed, true);
});

test('list rejects malformed responses and GraphQL errors rather than claiming an empty list', async () => {
  for (const body of ['not JSON', '{"errors":[{"message":"denied"}]}', 'null']) {
    const { browser, page, events } = fixture({ listResponse: true, body, empty: true });
    await assert.rejects(listScheduled(browser), error => error.code === 'UI_CHANGED');
    assert.equal(events.size, 0);
    assert.equal(page.closed, true);
  }
});

test('list cancels its watcher and closes the page if navigation fails', async () => {
  const { browser, page, events } = fixture();
  page.navigate = async () => { throw new Error('navigation failed'); };
  await assert.rejects(listScheduled(browser), /navigation failed/);
  assert.equal(events.size, 0);
  assert.equal(page.closed, true);
});
