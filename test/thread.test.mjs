import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../server/chrome.mjs';
import { XPosterError } from '../server/errors.mjs';

const home = await mkdtemp(join(tmpdir(), 'x-poster-thread-'));
process.env.X_POSTER_HOME = home;
process.env.X_POSTER_CHROME_PATH = '/fake/chrome';
const { validateThreadInput } = await import('../server/validate.mjs');
const { composeThread, fillThread, captureThread, checkOwnReply, mapThreadResponses, verifyScheduledThread,
  watchThreadResponses, readThreadFile } = await import('../server/thread.mjs');
const { config, saveState } = await import('../server/config.mjs');
const { callTool, threadPreview, threadPost, threadSchedule, post, exclusive, pendingWork } = await import('../server/tools.mjs');
const { appendHistory, readHistory } = await import('../server/limits.mjs');
after(() => rm(home, { recursive: true, force: true }));
const input = texts => texts.map(text => ({ text, images: [], weightedLength: text.length }));
const args = (extra = {}) => ({ posts: input(['first', 'second']), mode: 'post', screenshotPath: join(home, 'preview.png'), ...extra });
const body = id => JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: id } } } } });
const data = text => JSON.stringify({ variables: { tweet_text: text } });
const scheduledData = texts => JSON.stringify({ variables: { post_tweet_request: {
  status: texts[0], thread_tweets: texts.slice(1).map(status => ({ status, media_ids: [] })), media_ids: [],
} } });
const scheduleBody = '{"data":{"tweet":{"rest_id":"999"}}}';

function fixture(options = {}) {
  const calls = [];
  const events = new Map();
  const state = { active: 0, editors: [], attachments: new Set(), pathname: '/compose/post',
    replyHandle: 'Alice', username: 'alice', modal: true, scrollHeight: 600, containers: [], viewportHeight: 800, ...options };
  const button = { disabled: false, getAttribute: () => 'false' };
  const position = function(other) { return this.order === other.order ? 0 : this.order < other.order ? 4 : 2; };
  const attachmentAt = index => ({ order: index * 10 + 5, innerText: '', querySelector: () => null, compareDocumentPosition: position });
  const target = { innerText: 'original target' };
  const pageBody = { parentElement: null, clientHeight: 800, scrollHeight: 100000,
    get scrollTop() { return state.documentScroll ?? 0; },
    set scrollTop(value) { state.documentScroll = value; calls.push(['document-scroll', value]); },
  };
  const inner = { parentElement: null, clientHeight: 600, get scrollHeight() { return state.scrollHeight; },
    scrollTop: 0, overflowY: 'auto',
  };
  const root = {
    parentElement: pageBody, clientHeight: 600, scrollHeight: 600, scrollTop: 0, overflowY: 'visible',
    get innerText() { return `Replying to @${state.replyHandle}\noriginal target`; },
    getBoundingClientRect() { return state.rect ?? { x: 100, y: 40, right: 740, bottom: 640, width: 640, height: 600 }; },
    querySelector(selector) {
      if (selector === '[data-testid=tweetText]' || selector === '[data-testid=tweet], [data-testid=tweetText]') return state.noTarget ? null : target;
      const match = selector.match(/^\[data-testid=tweetTextarea_(\d+)\]$/);
      if (match) return state.editors[Number(match[1])] ?? null;
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      if (selector === '*') return [inner, ...state.containers, ...state.editors];
      if (selector === 'div, span') return [
        { innerText: state.replyLabel ?? `Replying to @${state.replyHandle}`, closest: () => null, querySelector: () => null },
        { innerText: 'Replying to @alice', closest: () => ({}), querySelector: () => null },
      ];
      if (selector === '[data-testid^=tweetTextarea_]') return [...state.containers, ...state.editors];
      if (selector === '[data-testid=attachments]') return [...state.attachments].map(attachmentAt);
      return [];
    },
  };
  inner.parentElement = root;
  inner.querySelector = () => null;
  inner.querySelectorAll = selector => root.querySelectorAll(selector);
  pageBody.querySelector = selector => root.querySelector(selector);
  pageBody.querySelectorAll = selector => root.querySelectorAll(selector);
  function addEditor() {
    const index = state.editors.length;
    const row = { parentElement: inner,
      getBoundingClientRect: () => ({ x: 120, y: 80, width: 400, height: 100 }),
      querySelector: selector => row.querySelectorAll(selector)[0] ?? null,
      querySelectorAll: selector => selector === '[data-testid=attachments]'
        ? state.attachments.has(index) ? [attachmentAt(index)] : []
          : selector === '[data-testid^=tweetTextarea_]' ? [container, editor] : [],
    };
    const container = { parentElement: row,
      getAttribute: () => `tweetTextarea_${index}RichTextInputContainer`,
      scrollIntoView() {},
      querySelector: () => null,
      querySelectorAll: selector => selector === '[data-testid^=tweetTextarea_]' ? [editor] : [],
      getBoundingClientRect: row.getBoundingClientRect,
    };
    const editor = { parentElement: container, textContent: '', order: index * 10,
      get innerText() { return this.textContent; },
      getAttribute: () => `tweetTextarea_${index}`,
      focus() { state.active = index; state.activeElement = editor; },
      closest() { return state.modal ? root : null; },
      contains(element) { return element === editor; },
      compareDocumentPosition: position,
      querySelector() { return null; },
      dispatchEvent(event) { this.textContent += event.clipboardData.value; },
      getBoundingClientRect: row.getBoundingClientRect,
    };
    state.containers.push(container); state.editors.push(editor);
  }
  addEditor();
  const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => String(first + i));
  class Select {
    constructor(values) { this.options = values.map(value => ({ value, text: value })); this.current = ''; }
    get value() { return this.current; }
    set value(value) { this.current = this.options.some(option => option.value === value) ? value : ''; }
    dispatchEvent() {}
  }
  const selects = [range(1, 12), range(1, 31), range(2026, 2030), range(0, 23), range(0, 59)].map(values => new Select(values));
  const scheduleDialog = { querySelectorAll: () => selects };
  const document = {
    body: pageBody, documentElement: pageBody, scrollingElement: pageBody,
    get activeElement() { return state.activeElement; },
    querySelector(selector) {
      if (selector === '[data-testid=scheduledConfirmationPrimaryAction]') return state.schedulingDialog ? button : null;
      if (selector === '[data-testid=AppTabBar_Profile_Link]') return state.username ? { getAttribute: () => '/' + state.username } : null;
      if (selector === 'main') return root;
      const container = selector.match(/\[data-testid=tweetTextarea_(\d+)RichTextInputContainer\]/);
      if (container) return state.noContainer ? null : state.containers[Number(container[1])] ?? null;
      if (selector.startsWith('[role=dialog] ') && !state.modal) return null;
      const match = selector.match(/\[data-testid=tweetTextarea_(\d+)\]/);
      if (match) return state.editors[Number(match[1])] ?? null;
      if (selector.endsWith('[data-testid=tweetButton]')) return button;
      if (selector === '[role=dialog]') return state.modal ? root : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[role=dialog]') return state.schedulingDialog ? [root, scheduleDialog] : state.modal ? [root] : [];
      return root.querySelectorAll(selector.replace('[role=dialog] ', ''));
    },
  };
  class DataTransfer { setData(type, value) { this.value = value; } }
  class ClipboardEvent { constructor(type, options) { Object.assign(this, options); } }
  const bodies = new Map();
  const emit = (requestId, postData, responseBody, operation = 'CreateTweet') => {
    bodies.set(requestId, responseBody);
    const url = `https://x.com/i/api/graphql/hash/${operation}`;
    events.get('Network.requestWillBeSent')?.({ requestId, request: { method: 'POST', url, postData } });
    events.get('Network.responseReceived')?.({ requestId, response: { url } });
    events.get('Network.loadingFinished')?.({ requestId });
  };
  const page = {
    closed: false,
    async navigate(url) { calls.push(['navigate', url]); },
    async call(fn, ...args) {
      return runInNewContext(`(${fn.toString()})(...args)`, {
        args, document, location: state, DataTransfer, ClipboardEvent, Event, HTMLSelectElement: Select,
        window: { innerWidth: 1200, innerHeight: state.viewportHeight }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        getComputedStyle: element => ({ overflowY: element.overflowY ?? 'visible' }),
        requestAnimationFrame: () => assert.fail('background tabs may pause animation frames'),
      });
    },
    async waitFor(fn, parameters = []) { return this.call(fn, ...parameters); },
    async press(key) { if (key === 'Backspace') state.editors[state.active].textContent = ''; },
    async insertText(text) { state.editors[state.active].textContent += text; },
    async setFiles(selector, files) {
      calls.push(['files', state.active, files]);
      if (!state.missingAttachment) state.attachments.add(state.wrongAttachmentIndex ?? state.active);
    },
    async click(selector) {
      calls.push(['click', selector]);
      if (selector.endsWith('[data-testid=addButton]')) { addEditor(); return; }
      if (selector.endsWith('[data-testid=scheduleOption]')) { state.schedulingDialog = true; return; }
      if (selector === '[data-testid=scheduledConfirmationPrimaryAction]') { state.schedulingDialog = false; return; }
      const match = selector.match(/tweetTextarea_(\d+)/);
      if (match) {
        const index = Number(match[1]);
        if (selector.includes('RichTextInputContainer') && state.containerCoveredClicks > 0) {
          state.containerCoveredClicks--;
          throw new XPosterError('UI_CHANGED', '页面按钮被遮挡。', { selector });
        }
        if (state.placeholderCovered && !selector.includes('RichTextInputContainer') && !state.editors[index].innerText) {
          throw new XPosterError('UI_CHANGED', '页面按钮被遮挡。', { selector });
        }
        if (!state.lostFocus) state.editors[index].focus();
        return;
      }
      state.onSubmit?.();
      if (state.clickError) throw state.clickError;
      if (state.noResponse) return;
      if (state.scheduled) {
        emit('schedule', state.schedulePayload ?? scheduledData(state.editors.map(editor => editor.innerText)), scheduleBody, 'CreateScheduledTweet');
      } else for (const [i, editor] of state.editors.entries()) emit(String(i), data(editor.innerText), body(String((state.idBase ?? 100) + i)));
    },
    async send(method, parameters) {
      calls.push(['send', method, parameters]);
      if (method === 'Network.getResponseBody') return { body: bodies.get(parameters.requestId) };
      if (method === 'Emulation.setDeviceMetricsOverride') state.viewportHeight = parameters.height;
      if (method === 'Emulation.clearDeviceMetricsOverride') state.viewportHeight = 800;
      if (method === 'Page.captureScreenshot') return { data: (await this.screenshot(parameters.clip)).toString('base64') };
      return {};
    },
    on(method, listener) { events.set(method, listener); return () => events.delete(method); },
    async screenshot(clip) {
      if (state.documentScroll) throw new Error('must not capture the home timeline');
      calls.push(['screenshot', inner.scrollTop, clip]); return Buffer.from('PNG at ' + inner.scrollTop);
    },
    async close() { this.closed = true; },
  };
  return { browser: { newPage: async () => page }, page, state, calls, events, emit, root, inner, pageBody };
}

function isolatedHistory(t, options = {}) {
  const old = { historyFile: config.historyFile, minIntervalSec: config.minIntervalSec, dailyLimit: config.dailyLimit, toolWaitSec: config.toolWaitSec };
  Object.assign(config, { historyFile: join(home, `history-${Math.random()}.jsonl`), minIntervalSec: 0, dailyLimit: 100, ...options });
  t.after(() => Object.assign(config, old));
}

function skipPollDelay(t) {
  // Advance only readiness deadlines; the response-watcher timeout has its own timer mock.
  const original = Date.now;
  let clock = original();
  t.mock.method(Date, 'now', () => { clock += 20000; return clock; });
}

test('thread validates counts, each item, image rules and modes before Browser.open', async t => {
  const opened = t.mock.method(Browser, 'open', () => assert.fail('must validate before browser'));
  const at = new Date(Date.now() + 86400000).toISOString();
  const invalid = [undefined, null, [], {}, { posts: [] }, { posts: [{ text: 'one' }] },
    { posts: Array(26).fill({ text: 'x' }) }, { posts: input(['one', 'two']), in_reply_to: 'abc' },
    { posts: input(['one']), in_reply_to: '123\n' }, { posts: input(['one']), in_reply_to: 123 },
    { posts: input(['one']), in_reply_to: '123', scheduled_at: at },
    { posts: [{}, { text: 'x' }] }, { posts: [{ text: false }, { text: 'x' }] },
    { posts: [{ text: 'x', images: Array(5).fill('/tmp/a.png') }, { text: 'x' }] },
    { posts: [{ images: ['relative.png'] }, { text: 'x' }] },
    { posts: [{ images: ['/tmp/x-thread.svg'] }, { text: 'x' }] },
    { posts: [{ images: [join(home, 'missing.png')] }, { text: 'x' }] }];
  // Public input has only text/images: computed weightedLength is internal.
  for (const bad of invalid) {
    for (const run of [threadPreview, threadPost, threadSchedule]) {
      await assert.rejects(run(bad), error => error.code === 'INVALID_INPUT');
    }
  }
  for (const count of [2, 25]) assert.equal((await validateThreadInput({ posts: Array(count).fill({ text: 'x' }) })).posts.length, count);
  for (const count of [1, 25]) assert.equal((await validateThreadInput({ posts: Array(count).fill({ text: 'x' }), in_reply_to: '123' })).posts.length, count);
  assert.equal(opened.mock.callCount(), 0);
});

test('fill clicks add N-1 times, pastes each editor, and focuses before each shared file input', { timeout: 4500 }, async () => {
  const f = fixture();
  const posts = input(['one\n你好', 'two', '']);
  posts[0].images = ['/tmp/1.png']; posts[2].images = ['/tmp/2.png', '/tmp/3.png'];
  await fillThread(f.page, '[role=dialog] ', posts);
  assert.equal(f.calls.filter(call => call[0] === 'click' && call[1].endsWith('[data-testid=addButton]')).length, 2);
  assert.deepEqual(f.state.editors.map(editor => editor.innerText), posts.map(post => post.text));
  assert.deepEqual(f.calls.filter(call => call[0] === 'files'), [['files', 0, posts[0].images], ['files', 2, posts[2].images]]);
  for (const index of [0, 2]) {
    const position = f.calls.findIndex(call => call[0] === 'files' && call[1] === index);
    assert.equal(f.calls[position - 1][1], `[role=dialog] [data-testid=tweetTextarea_${index}RichTextInputContainer]`);
  }
});

test('another post attachments cannot satisfy readiness for the current post', { timeout: 4500 }, async t => {
  skipPollDelay(t);
  const f = fixture({ missingAttachment: true });
  f.state.attachments.add(0);
  await assert.rejects(fillThread(f.page, '[role=dialog] ', [{ text: 'first', images: ['/tmp/first.png'], weightedLength: 5 }, { text: '', images: ['/tmp/a.png'], weightedLength: 0 }]),
    error => error.code === 'UI_CHANGED');
  assert.equal(f.calls.some(call => call[0] === 'click' && call[1].endsWith('[data-testid=tweetButton]')), false);
});

test('response mapping uses request order, normalized text and unique ids', () => {
  const records = [
    { postData: data('first\n post'), body: body('10') },
    { postData: data('unrelated'), body: body('50') },
    { postData: data(' second '), body: body('11') },
  ];
  assert.deepEqual(mapThreadResponses(records, input(['first post', 'second'])), ['10', '11']);
  records[0].body = null;
  assert.deepEqual(mapThreadResponses(records, input(['first post', 'second'])), ['11']);
  const grouped = [{ postData: scheduledData(['first post', 'second']), body: JSON.stringify({ data: {
    first: { tweet_results: { result: { rest_id: '10', quoted_status_result: { result: { rest_id: '900' } } } } },
    thread_tweets: [{ tweet_results: { result: { rest_id: '11' } } }],
  } }) }];
  assert.deepEqual(mapThreadResponses(grouped, input(['first post', 'second'])), ['10', '11']);
  grouped[0].body = JSON.stringify({ data: { create_tweet: { tweet_results: { result: {
    rest_id: '10', thread_tweets: [{ rest_id: '11' }], quoted_status_result: { result: { rest_id: '900' } },
  } } } } });
  assert.deepEqual(mapThreadResponses(grouped, input(['first post', 'second'])), ['10', '11']);
  grouped[0].postData = scheduledData(['wrong', 'second']);
  assert.deepEqual(mapThreadResponses(grouped, input(['first post', 'second'])), []);
});

test('watcher records CreateTweet, CreatePost, NoteTweet and base64 responses arriving out of order', async () => {
  const f = fixture();
  const watcher = watchThreadResponses(f.page, input(['a', 'b', 'c']));
  const bodies = { r1: body('1'), r2: body('2'), r3: body('3') };
  f.page.send = async (method, { requestId }) => ({ body: Buffer.from(bodies[requestId]).toString('base64'), base64Encoded: true });
  for (const [i, operation] of ['CreateTweet', 'CreatePost', 'NoteTweet'].entries()) {
    f.events.get('Network.requestWillBeSent')({ requestId: 'r' + (i + 1), request: {
      url: `https://x.com/i/api/graphql/hash/${operation}`, method: 'POST', postData: data(['a', 'b', 'c'][i]),
    } });
  }
  for (const requestId of ['r3', 'r1', 'r2']) {
    f.events.get('Network.responseReceived')({ requestId, response: { url: 'unused' } });
    f.events.get('Network.loadingFinished')({ requestId });
  }
  assert.deepEqual((await watcher.done).posted_ids, ['1', '2', '3']);
  assert.equal(f.events.size, 0);
});

test('immediate compose returns N sequential ids and closes its fresh page', { timeout: 4500 }, async () => {
  const f = fixture();
  assert.deepEqual((await composeThread(f.browser, args())).posted_ids, ['100', '101']);
  assert.equal(f.page.closed, true);
  assert.equal(f.events.size, 0);
});

test('single thread_tweets request maps all confirmed ids', async () => {
  const f = fixture();
  const watcher = watchThreadResponses(f.page, input(['a', 'b']));
  f.emit('all', scheduledData(['a', 'b']), JSON.stringify({ data: { thread_tweets: [{ rest_id: '1' }, { rest_id: '2' }] } }));
  assert.deepEqual((await watcher.done).posted_ids, ['1', '2']);
  assert.equal(f.events.size, 0);
});

test('fewer than N confirmed ids after 90 s is UNCERTAIN with posted_ids; never retries', { timeout: 4500 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clicked;
  const submitted = new Promise(resolve => { clicked = resolve; });
  const f = fixture({ noResponse: true, onSubmit: () => { f.emit('one', data('first'), body('100')); clicked(); } });
  const action = composeThread(f.browser, args());
  await submitted;
  const rejected = assert.rejects(action, error => {
    assert.equal(error.code, 'UNCERTAIN'); assert.deepEqual(error.details.posted_ids, ['100']);
    assert.equal(error.details.count, 2); assert.match(error.hint, /不要重试.*串文是否完整/); return true;
  });
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(90000);
  await rejected;
  assert.equal(f.calls.filter(call => call[0] === 'click' && call[1].endsWith('[data-testid=tweetButton]')).length, 1);
  assert.equal(f.events.size, 0); assert.equal(f.page.closed, true);
});

test('schedule verifies exact thread_tweets count and whitespace-normalized status texts', () => {
  const posts = input(['a b', 'c']);
  assert.equal(verifyScheduledThread(scheduledData([' a\nb ', 'c']), posts), true);
  assert.equal(verifyScheduledThread(scheduledData(['a b']), posts), false);
  assert.equal(verifyScheduledThread(scheduledData(['a b', 'c', 'extra']), posts), false);
  assert.equal(verifyScheduledThread(scheduledData(['a b', 'changed']), posts), false);
  assert.equal(verifyScheduledThread('{}', posts), false);
});

test('native scheduled thread succeeds or reports UNCERTAIN on outgoing mismatch, without cancelling', { timeout: 4500 }, async () => {
  const at = { year: 2027, month: 1, day: 2, hour: 10, minute: 30 };
  for (const mismatch of [false, true]) {
    const f = fixture({ scheduled: true, ...(mismatch ? { schedulePayload: scheduledData(['first', 'wrong']) } : {}) });
    const action = composeThread(f.browser, args({ mode: 'schedule', scheduledAt: at }));
    if (mismatch) await assert.rejects(action, error => error.code === 'UNCERTAIN' && /预排期列表/.test(error.hint));
    else assert.equal((await action).id, '999');
    assert.equal(f.events.size, 0); assert.equal(f.page.closed, true);
    assert.equal(f.calls.filter(call => call[0] === 'click' && call[1].endsWith('[data-testid=tweetButton]')).length, 1);
  }
});

test('scheduled request count mismatch and missing postData are safely handled by the watcher', async () => {
  const f = fixture();
  const mismatch = watchThreadResponses(f.page, input(['a', 'b']), { scheduled: true });
  f.emit('schedule', scheduledData(['a']), scheduleBody, 'CreateScheduledTweet');
  assert.equal(await mismatch.done, null); assert.equal(f.events.size, 0);
  const fetched = watchThreadResponses(f.page, input(['a', 'b']));
  const originalSend = f.page.send;
  f.page.send = async (method, parameters) => method === 'Network.getRequestPostData'
    ? { postData: data('a') } : originalSend(method, parameters);
  f.emit('one', undefined, body('1'));
  f.emit('two', data('b'), body('2'));
  assert.deepEqual((await fetched.done).posted_ids, ['1', '2']);
});

test('malformed or failed response bodies never invent ids and watchers clean up at timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const watcher = watchThreadResponses(f.page, input(['a', 'b']));
  f.emit('one', data('a'), 'not JSON');
  f.emit('two', data('b'), '{"errors":[{"code":226}]}');
  f.events.get('Network.loadingFailed')({ requestId: 'one' });
  t.mock.timers.tick(90000);
  assert.equal(await watcher.done, null); assert.deepEqual(watcher.postedIds(), []);
  assert.equal(f.events.size, 0);
});

test('own-post check accepts case differences and saved username, rejects another handle or missing identity', async () => {
  for (const [username, replyHandle, fallback, code] of [
    ['alice', 'ALICE', undefined, null], [null, 'alice', 'Alice', null], ['alice', 'bob', undefined, 'INVALID_INPUT'],
    [null, 'alice', undefined, 'UI_CHANGED'], ['alice', '', undefined, 'UI_CHANGED'],
  ]) {
    const f = fixture({ username, replyHandle, modal: false });
    const action = checkOwnReply(f.page, '', fallback);
    if (code) await assert.rejects(action, error => error.code === code);
    else assert.equal((await action).reply_to_username.toLowerCase(), 'alice');
  }
  const chinese = fixture({ replyLabel: '回复 @ALICE' });
  assert.equal((await checkOwnReply(chinese.page, '[role=dialog] ')).reply_to_username, 'alice');
});

test('append chains each fresh reply intent to the previous new id', { timeout: 4500 }, async () => {
  const pages = [];
  const browser = { newPage: async () => { const f = fixture({ modal: false, idBase: 200 + pages.length }); pages.push(f); return f.page; } };
  const result = await composeThread(browser, args({ inReplyTo: '99' }));
  assert.deepEqual(result.posted_ids, ['200', '201']);
  assert.deepEqual(pages.map(f => f.calls[0][1]), ['https://x.com/intent/post?in_reply_to=99', 'https://x.com/intent/post?in_reply_to=200']);
  assert.ok(pages.every(f => f.page.closed));
});

test('append step 2 transport failure reports first id, stops, and charges only posts possibly sent', { timeout: 4500 }, async () => {
  const pages = [];
  const browser = { newPage: async () => {
    const f = fixture(pages.length ? { clickError: new Error('transport') } : {});
    pages.push(f); return f.page;
  } };
  await assert.rejects(composeThread(browser, args({ posts: input(['a', 'b', 'c']), inReplyTo: '99' })), error => {
    assert.equal(error.code, 'UNCERTAIN'); assert.deepEqual(error.details.posted_ids, ['100']);
    assert.equal(error.details.count, 2); return true;
  });
  assert.equal(pages.length, 2); assert.ok(pages.every(f => f.page.closed));
});

test('append rejects another user before filling or submitting', async () => {
  const f = fixture({ replyHandle: 'bob' });
  await assert.rejects(composeThread(f.browser, args({ inReplyTo: '99' })), error => error.code === 'INVALID_INPUT');
  assert.equal(f.state.editors[0].innerText, ''); assert.equal(f.calls.some(call => call[0] === 'click'), false);
});

test('screenshots cover overlapping inner scroll slices and clear device metrics even on failure', async () => {
  const f = fixture({ scrollHeight: 1600 });
  const { screenshots } = await captureThread(f.page, join(home, 'scroll.png'));
  assert.deepEqual(f.calls.filter(call => call[0] === 'screenshot').map(call => call[1]), [0, 540, 1000]);
  for (const shot of screenshots) assert.deepEqual(await readFile(shot.path), shot.image);
  assert.equal(f.calls.at(-1)[1], 'Emulation.clearDeviceMetricsOverride');
  f.page.screenshot = async () => { throw new Error('screenshot failed'); };
  await assert.rejects(captureThread(f.page, join(home, 'fail.png')), /screenshot failed/);
  assert.equal(f.calls.at(-1)[1], 'Emulation.clearDeviceMetricsOverride');
});

test('preview returns all MCP images, weighted lengths, warning and exact scheduled time without history', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const f = fixture({ scrollHeight: 12000 });
  const gate = pauseBrowser(t, { ...f.browser, isLoggedIn: async () => true, close: async () => {} });
  const at = new Date(Math.ceil((Date.now() + 86400000) / 60000) * 60000 + 1000).toISOString();
  const running = callTool('x_thread_preview', { posts: [{ text: '中'.repeat(141) }, { text: 'second' }], scheduled_at: at });
  const progress = await gate.progress(running);
  assert.match(progress.next_step, /x_job_status.*不要再次调用 x_thread_preview/);
  gate.release();
  const result = await callTool('x_job_status', { job_id: progress.job_id });
  assert.equal(result.isError, undefined, result.content[0].text);
  const preview = JSON.parse(result.content[0].text);
  assert.equal(preview.posts[0].weighted_length, 282); assert.ok(preview.posts[0].warning);
  assert.equal(preview.job_id, progress.job_id);
  assert.equal(preview.count, 2); assert.ok(preview.scheduled_at_local);
  assert.equal(Date.parse(preview.scheduled_at), Math.ceil(Date.parse(at) / 60000) * 60000);
  assert.equal(result.content.filter(item => item.type === 'image').length, preview.screenshots.length);
  assert.equal(preview.screenshots.length, 8);
  assert.deepEqual(preview.warnings, ['串文较长，截图只覆盖前面部分，请在 X 中检查']);
  assert.match(preview.next_step, /截图未覆盖整串.*在 X 中检查/);
  assert.match(preview.next_step, /所有截图.*每一条.*完全相同.*x_thread_schedule/);
  assert.deepEqual(await readHistory(config.historyFile), []);
  assert.equal(f.calls.some(call => call[0] === 'click' && call[1].endsWith('[data-testid=tweetButton]')), false);
});

test('append preview captures target and all posts in a separate normal composer, never posting', { timeout: 4500 }, async t => {
  isolatedHistory(t); await saveState({ username: 'Alice' });
  const pages = [];
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => true, close: async () => {}, newPage: async () => {
    const f = fixture({ username: null, modal: pages.length > 0, scrollHeight: 12000 }); pages.push(f); return f.page;
  } }));
  const result = await threadPreview({ posts: [{ text: 'a' }, { text: 'b' }], in_reply_to: '99' });
  assert.equal(result.data.in_reply_to, '99'); assert.equal(result.data.reply_to_username, 'alice');
  assert.equal(result.data.target_text, 'original target'); assert.equal(pages.length, 2);
  assert.equal(result.images.length, 8); assert.match(result.data.next_step, /仅用于预览/);
  assert.deepEqual(result.data.warnings, ['串文较长，截图只覆盖前面部分，请在 X 中检查']);
  assert.equal(pages[0].calls.filter(call => call[1] === 'Page.captureScreenshot').length, 1);
  assert.equal(pages[1].calls.filter(call => call[1] === 'Page.captureScreenshot').length, 7);
  assert.deepEqual(pages[1].state.editors.map(editor => editor.innerText), ['a', 'b']);
  assert.ok(pages.every(f => f.page.closed));
});

test('thread limits reject requested N before browser opens and expose remaining capacity', async t => {
  isolatedHistory(t, { dailyLimit: 5 });
  await appendHistory(config.historyFile, { ts: new Date().toISOString(), ids: ['1', '2', '3', '4'], thread: true, count: 4 });
  const opened = t.mock.method(Browser, 'open', () => assert.fail('limited operation must not open Chrome'));
  for (const action of [() => threadPost({ posts: [{ text: 'a' }, { text: 'b' }] }),
    () => threadSchedule({ posts: [{ text: 'a' }, { text: 'b' }], scheduled_at: new Date(Date.now() + 86400000).toISOString() })]) {
    await assert.rejects(action(), error => error.code === 'RATE_LIMITED' && error.details.posts_remaining === 1
      && error.details.requested_count === 2 && /剩余可发布 1 条/.test(error.message));
  }
  assert.equal(opened.mock.callCount(), 0);
});

test('thread history charges N once, affects single-post limits, and retains all confirmed ids', { timeout: 4500 }, async t => {
  isolatedHistory(t, { dailyLimit: 2 });
  const f = fixture();
  const opened = t.mock.method(Browser, 'open', async () => ({ ...f.browser, isLoggedIn: async () => true, close: async () => {} }));
  const response = await callTool('x_thread_post', { posts: [{ text: 'a' }, { text: 'b' }] });
  assert.equal(response.isError, undefined, response.content[0].text);
  const result = { data: JSON.parse(response.content[0].text) };
  assert.match(result.data.job_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.data.status, undefined);
  assert.deepEqual(await callTool('x_job_status', { job_id: result.data.job_id }), response);
  assert.deepEqual(result.data.posted_ids, ['100', '101']);
  assert.equal(result.data.thread_url, 'https://x.com/alice/status/100');
  assert.deepEqual(result.data.urls, ['https://x.com/alice/status/100', 'https://x.com/alice/status/101']);
  const history = await readHistory(config.historyFile);
  assert.equal(history.length, 1); assert.equal(history[0].count, 2); assert.equal(history[0].thread, true);
  assert.deepEqual(history[0].ids, ['100', '101']);
  await assert.rejects(post({ text: 'single' }), error => error.code === 'RATE_LIMITED');
  assert.equal(opened.mock.callCount(), 1);
});

test('scheduled thread history is one counted entry with scheduled_for and id', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const f = fixture({ scheduled: true });
  const gate = pauseBrowser(t, { ...f.browser, isLoggedIn: async () => true, close: async () => {} });
  const running = callTool('x_thread_schedule', { posts: [{ text: 'a' }, { text: 'b' }], scheduled_at: new Date(Date.now() + 86400000).toISOString() });
  const progress = await gate.progress(running);
  assert.match(progress.next_step, /x_job_status.*绝不要.*x_thread_post.*x_thread_schedule.*重复串文.*UNCERTAIN.*预排期列表/);
  gate.release();
  const response = await callTool('x_job_status', { job_id: progress.job_id });
  assert.equal(response.isError, undefined, response.content[0].text);
  const result = { data: JSON.parse(response.content[0].text) };
  assert.equal(result.data.job_id, progress.job_id);
  assert.equal(result.data.scheduled, true); assert.equal(result.data.count, 2); assert.equal(result.data.id, '999');
  const history = await readHistory(config.historyFile);
  assert.equal(history.length, 1); assert.equal(history[0].count, 2); assert.equal(history[0].thread, true);
  assert.equal(history[0].id, '999'); assert.equal(history[0].scheduled_for, result.data.scheduled_at);
});

test('UNCERTAIN submit records full N and known ids; no second submission', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const f = fixture({ clickError: new Error('transport') });
  t.mock.method(Browser, 'open', async () => ({ ...f.browser, isLoggedIn: async () => true, close: async () => {} }));
  await assert.rejects(threadPost({ posts: [{ text: 'a' }, { text: 'b' }] }), error => error.code === 'UNCERTAIN');
  const history = await readHistory(config.historyFile);
  assert.equal(history.length, 1); assert.equal(history[0].count, 2); assert.equal(history[0].uncertain, true);
  assert.deepEqual(history[0].posted_ids, []);
  assert.equal(f.calls.filter(call => call[0] === 'click' && call[1].endsWith('[data-testid=tweetButton]')).length, 1);
});

test('append partial failure persists known ids and the possible submission count', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const pages = [];
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => true, close: async () => {}, newPage: async () => {
    const f = fixture(pages.length ? { clickError: new Error('transport failed') } : {});
    pages.push(f); return f.page;
  } }));
  const result = await callTool('x_thread_post', { posts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], in_reply_to: '99' });
  const failure = JSON.parse(result.content[0].text);
  assert.equal(failure.code, 'UNCERTAIN'); assert.deepEqual(failure.posted_ids, ['100']); assert.equal(pages.length, 2);
  const history = await readHistory(config.historyFile);
  assert.equal(history[0].count, 2); assert.equal(history[0].uncertain, true); assert.deepEqual(history[0].posted_ids, ['100']);
});

test('unknown username uses i/status URLs and append thread_url remains the target', { timeout: 4500 }, async t => {
  isolatedHistory(t); await saveState({ username: null });
  let f = fixture({ username: null });
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => true, close: async () => {}, newPage: async () => f.page }));
  const created = await threadPost({ posts: [{ text: 'a' }, { text: 'b' }] });
  assert.equal(created.data.thread_url, 'https://x.com/i/status/100');
  f = fixture();
  const appended = await threadPost({ posts: [{ text: 'a' }], in_reply_to: '99' });
  assert.equal(appended.data.thread_url, 'https://x.com/alice/status/99');
});

test('history write failure after a confirmed thread remains UNCERTAIN and preserves every id', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  t.mock.method(console, 'error', () => {});
  const f = fixture({ onSubmit: () => { config.historyFile = home; } });
  t.mock.method(Browser, 'open', async () => ({ ...f.browser, isLoggedIn: async () => true, close: async () => {} }));
  await assert.rejects(threadPost({ posts: [{ text: 'a' }, { text: 'b' }] }), error => {
    assert.equal(error.code, 'UNCERTAIN'); assert.deepEqual(error.details.posted_ids, ['100', '101']);
    assert.match(error.hint, /不要重试/); return true;
  });
});

test('thread approval policy prompts only on the two added submit tools', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.codex-mcp.json', import.meta.url), 'utf8'));
  const approvals = manifest.mcpServers['x-poster'].tools;
  assert.deepEqual(approvals.x_thread_post, { approval_mode: 'prompt' });
  assert.deepEqual(approvals.x_thread_schedule, { approval_mode: 'prompt' });
  assert.equal(approvals.x_thread_preview, undefined);
});

test('BUSY-rejected thread is skipped permanently, even after queue becomes free', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const old = config.busyWaitSec; config.busyWaitSec = 0.02; t.after(() => { config.busyWaitSec = old; });
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const occupied = exclusive(async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await started;
  const opened = t.mock.method(Browser, 'open', () => assert.fail('expired thread must never run'));
  await assert.rejects(threadPost({ posts: [{ text: 'a' }, { text: 'b' }] }), error => error.code === 'BUSY');
  release(); await occupied; await pendingWork(); assert.equal(opened.mock.callCount(), 0);
});

test('CLI thread JSON and Markdown resolve local images relative to file and preserve multiline text', async () => {
  const json = join(home, 'thread.json'); const md = join(home, 'thread.md');
  await writeFile(json, JSON.stringify([{ text: 'a\nb', images: ['./one.png'] }, { images: ['~/two.jpg'] }]));
  const posts = await readThreadFile(json);
  assert.equal(posts[0].text, 'a\nb'); assert.equal(posts[0].images[0], join(home, 'one.png'));
  assert.ok(posts[1].images[0].endsWith('/two.jpg')); assert.ok(posts[1].images[0].startsWith('/'));
  await writeFile(md, '第一条\r\n换行\r\n![](one.png)\r\n---\r\n![](<two image.png>)\r\n第二条');
  assert.deepEqual(await readThreadFile(md), [
    { text: '第一条\n换行', images: [join(home, 'one.png')] },
    { text: '第二条', images: [join(home, 'two image.png')] },
  ]);
  for (const source of ['{}', 'null', '[1]', '[{"images":"bad"}]', '[{"images":[null]}]']) {
    await writeFile(json, source); await assert.rejects(readThreadFile(json), error => error.code === 'INVALID_INPUT');
  }
});


test('image-only middle post maps empty or omitted request text regardless of media payload', () => {
  const posts = [{ text: 'first' }, { images: ['/tmp/only.png'] }, { text: 'third' }];
  for (const middle of [{ tweet_text: '', media: { media_entities: [{ media_id: '7' }] } },
    { media: { media_entities: [{ media_id: '7' }] } }]) {
    const records = [
      { postData: data('first'), body: body('1') },
      { postData: JSON.stringify({ variables: middle }), body: body('2') },
      { postData: data('third'), body: body('3') },
    ];
    assert.deepEqual(mapThreadResponses(records, posts), ['1', '2', '3']);
    records[2].postData = data('different');
    assert.deepEqual(mapThreadResponses(records, posts), ['1', '2']);
  }
});

test('scheduled image-only post verifies empty or omitted status and keeps text matching strict', () => {
  const posts = [{ text: 'first' }, { images: ['/tmp/only.png'] }];
  for (const imagePost of [{ status: '', media_ids: ['7'] }, { media: { media_entities: [{ media_id: '7' }] } }]) {
    const payload = JSON.stringify({ variables: { post_tweet_request: { status: 'first', thread_tweets: [imagePost] } } });
    assert.equal(verifyScheduledThread(payload, posts), true);
    assert.equal(verifyScheduledThread(payload, [{ text: 'first' }, { text: 'not empty' }]), false);
  }
});

test('append chain handles a middle post whose text is missing and only attaches an image', { timeout: 4500 }, async () => {
  const pages = [];
  const browser = { newPage: async () => { const f = fixture({ modal: false, idBase: 300 + pages.length }); pages.push(f); return f.page; } };
  const posts = [input(['first'])[0], { images: ['/tmp/only.png'], weightedLength: 0 }, input(['third'])[0]];
  const result = await composeThread(browser, args({ posts, inReplyTo: '99' }));
  assert.deepEqual(result.posted_ids, ['300', '301', '302']);
  assert.deepEqual(pages.map(f => f.calls[0][1]), ['https://x.com/intent/post?in_reply_to=99',
    'https://x.com/intent/post?in_reply_to=300', 'https://x.com/intent/post?in_reply_to=301']);
  assert.deepEqual(pages[1].calls.find(call => call[0] === 'files'), ['files', 0, ['/tmp/only.png']]);
});


function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pauseBrowser(t, browser) {
  config.toolWaitSec = 45;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entered = deferred(); const gate = deferred();
  const opened = t.mock.method(Browser, 'open', async () => {
    entered.resolve(); await gate.promise; return browser;
  });
  t.after(async () => { gate.resolve(); await pendingWork(); });
  return { entered: entered.promise, release: gate.resolve, fail: gate.reject, opened,
    async progress(running) {
      await entered.promise;
      t.mock.timers.tick(45000);
      const result = await running;
      assert.equal(result.isError, undefined, result.content[0].text);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.ok, true); assert.equal(data.status, 'in_progress');
      assert.equal(data.waiting_for_browser, false); assert.equal(data.elapsed_sec, 45);
      assert.match(data.job_id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
      return data;
    },
  };
}

test('slow thread post returns a job and both status tools return final ids until one-hour expiry', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const f = fixture();
  const gate = pauseBrowser(t, { ...f.browser, isLoggedIn: async () => true, close: async () => {} });
  const running = callTool('x_thread_post', { posts: [{ text: 'first' }, { text: 'second' }] });
  const progress = await gate.progress(running);
  assert.match(progress.next_step, /job_id.*x_job_status.*绝不要.*x_thread_post.*x_thread_schedule.*重复串文.*UNCERTAIN.*主页/);
  const waiting = callTool('x_article_status', { job_id: progress.job_id });
  t.mock.timers.tick(45000);
  assert.equal(JSON.parse((await waiting).content[0].text).status, 'in_progress');
  gate.release();
  const result = await callTool('x_job_status', { job_id: progress.job_id });
  assert.equal(result.isError, undefined, result.content[0].text);
  const final = JSON.parse(result.content[0].text);
  assert.equal(final.job_id, progress.job_id); assert.deepEqual(final.posted_ids, ['100', '101']);
  assert.equal(final.count, 2); assert.equal(final.thread_url, 'https://x.com/alice/status/100');
  assert.deepEqual(await callTool('x_article_status', { job_id: progress.job_id.toUpperCase() }), result);
  assert.equal(gate.opened.mock.callCount(), 1);
  t.mock.timers.tick(3599999);
  assert.deepEqual(await callTool('x_job_status', { job_id: progress.job_id }), result);
  t.mock.timers.tick(1);
  assert.equal(JSON.parse((await callTool('x_job_status', { job_id: progress.job_id })).content[0].text).code, 'INVALID_INPUT');
});

test('late thread job UNCERTAIN preserves posted_ids and every original error detail through either status tool', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const gate = pauseBrowser(t, null);
  const progress = await gate.progress(callTool('x_thread_post', { posts: [{ text: 'first' }, { text: 'second' }] }));
  const failure = new XPosterError('UNCERTAIN', '串文可能已部分发布。', { posted_ids: ['123'], count: 2, hint: '不要重试，请用户检查主页上的串文是否完整。' });
  gate.fail(failure);
  const result = await callTool('x_job_status', { job_id: progress.job_id });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, ...failure.toJSON() });
  assert.deepEqual(await callTool('x_article_status', { job_id: progress.job_id }), result);
});

test('all MCP thread input errors return without a job, timer or browser queue slot', async t => {
  isolatedHistory(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const opened = t.mock.method(Browser, 'open', () => assert.fail('invalid input must not start browser work'));
  const queue = pendingWork();
  for (const tool of ['x_thread_preview', 'x_thread_post', 'x_thread_schedule']) {
    for (const input of [{}, { posts: [{ text: 'one' }] }, { posts: [{ text: 'a' }, {}] },
      { posts: [{ text: 'a' }, { text: 'b' }], in_reply_to: 'bad' }]) {
      const result = await callTool(tool, input);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.code, 'INVALID_INPUT'); assert.equal(data.job_id, undefined);
      assert.equal(pendingWork(), queue);
    }
  }
  t.mock.timers.tick(900000);
  assert.equal(opened.mock.callCount(), 0);
});

async function jobClock(t, promise) {
  let outcome;
  promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  const deadline = performance.now() + 2000;
  while (!outcome) {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(performance.now() < deadline, 'job did not settle within two seconds');
    if (!outcome) t.mock.timers.tick(10);
  }
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

test('thread jobs wait beyond the synchronous BUSY limit and expired jobs never run later', { timeout: 4500 }, async t => {
  isolatedHistory(t); config.toolWaitSec = 0.01;
  const entered = deferred(); const gate = deferred();
  const blocker = exclusive(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const opened = t.mock.method(Browser, 'open', () => assert.fail('expired job must never open Chrome'));
  try {
    const response = await jobClock(t, callTool('x_thread_post', { posts: [{ text: 'a' }, { text: 'b' }] }));
    const progress = JSON.parse(response.content[0].text);
    assert.equal(progress.status, 'in_progress'); assert.equal(progress.waiting_for_browser, true);
    t.mock.timers.tick(120000);
    const stillWaiting = await jobClock(t, callTool('x_job_status', { job_id: progress.job_id }));
    assert.equal(JSON.parse(stillWaiting.content[0].text).waiting_for_browser, true);
    t.mock.timers.tick(15 * 60 * 1000);
    const rejected = await jobClock(t, callTool('x_job_status', { job_id: progress.job_id }));
    assert.equal(rejected.isError, true); assert.equal(JSON.parse(rejected.content[0].text).code, 'BUSY');
  } finally { gate.resolve(); await blocker; await pendingWork(); }
  assert.equal(opened.mock.callCount(), 0);
});


test('CLI thread entry waits beyond the MCP deadline and returns only a synchronous final result', { timeout: 4500 }, async t => {
  isolatedHistory(t);
  const f = fixture();
  const gate = pauseBrowser(t, { ...f.browser, isLoggedIn: async () => true, close: async () => {} });
  let returned = false;
  const running = threadPost({ posts: [{ text: 'a' }, { text: 'b' }] }).then(result => { returned = true; return result; });
  await gate.entered;
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(returned, false);
  gate.release();
  const result = await running;
  assert.equal(result.data.status, undefined); assert.equal(result.data.job_id, undefined);
  assert.deepEqual(result.data.posted_ids, ['100', '101']);
});


test('empty image post focuses through its rich-text container despite the placeholder', { timeout: 4500 }, async () => {
  const f = fixture({ placeholderCovered: true });
  await fillThread(f.page, '[role=dialog] ', [{ text: '', images: ['/tmp/one.png'], weightedLength: 0 }]);
  assert.equal(f.state.activeElement, f.state.editors[0]);
  assert.ok(f.calls.some(call => call[0] === 'click' && call[1] === '[role=dialog] [data-testid=tweetTextarea_0RichTextInputContainer]'));
});

test('a briefly covered container is retried, and a persistently covered one falls back to focus', { timeout: 4500 }, async t => {
  const briefly = fixture({ containerCoveredClicks: 2 });
  await fillThread(briefly.page, '[role=dialog] ', [{ text: '', images: ['/tmp/one.png'], weightedLength: 0 }]);
  assert.equal(briefly.state.activeElement, briefly.state.editors[0]);
  assert.equal(briefly.calls.filter(call => call[0] === 'click' && call[1].includes('RichTextInputContainer')).length, 3);
  const original = Date.now;
  let clock = original();
  t.mock.method(Date, 'now', () => { clock += 1000; return clock; });
  const always = fixture({ containerCoveredClicks: Infinity });
  await fillThread(always.page, '[role=dialog] ', [{ text: '', images: ['/tmp/one.png'], weightedLength: 0 }]);
  assert.equal(always.state.activeElement, always.state.editors[0]);
  assert.deepEqual(always.calls.find(call => call[0] === 'files')?.[2], ['/tmp/one.png']);
});

test('a fitting dialog gives one clipped screenshot without scrolling the taller home document', async () => {
  const f = fixture();
  const result = await captureThread(f.page, join(home, 'bounded.png'));
  assert.equal(result.screenshots.length, 1); assert.equal(result.truncated, false);
  assert.equal(f.calls.some(call => call[0] === 'document-scroll'), false);
});

test('missing rich-text container falls back to focus and trusted mouse events', { timeout: 4500 }, async () => {
  const f = fixture({ noContainer: true, placeholderCovered: true });
  await fillThread(f.page, '[role=dialog] ', [{ text: '', images: ['/tmp/one.png'], weightedLength: 0 }]);
  assert.equal(f.state.activeElement, f.state.editors[0]);
  const events = f.calls.filter(call => call[1] === 'Input.dispatchMouseEvent').map(call => call[2]);
  assert.deepEqual(events.map(event => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(events.every(event => event.x >= 120 && event.x <= 520 && event.y >= 80 && event.y <= 180));
  assert.equal(f.calls.some(call => call[0] === 'click'), false);
});

test('lost editor focus stops before setting files', async () => {
  const f = fixture({ lostFocus: true });
  await assert.rejects(fillThread(f.page, '[role=dialog] ', [{ text: '', images: ['/tmp/one.png'], weightedLength: 0 }]),
    error => error.code === 'UI_CHANGED' && /焦点/.test(error.message));
  assert.equal(f.calls.some(call => call[0] === 'files'), false);
});

test('attachments before the current editor or after the next editor raise UI_CHANGED', { timeout: 4500 }, async () => {
  const previous = fixture({ wrongAttachmentIndex: 0 });
  await assert.rejects(fillThread(previous.page, '[role=dialog] ', [
    { text: 'first', images: [], weightedLength: 5 }, { text: '', images: ['/tmp/wrong.png'], weightedLength: 0 },
  ]), error => error.code === 'UI_CHANGED' && /图片未出现/.test(error.message));
  const next = fixture({ wrongAttachmentIndex: 1 });
  await next.page.click('[role=dialog] [data-testid=addButton]');
  await assert.rejects(fillThread(next.page, '[role=dialog] ', [{ text: '', images: ['/tmp/wrong.png'], weightedLength: 0 }]),
    error => error.code === 'UI_CHANGED' && /下一条帖子之前/.test(error.message));
});

test('screenshot clips stay inside the composer, viewport growth is capped, and captures stop at eight', async () => {
  const f = fixture({ scrollHeight: 100000 });
  const result = await captureThread(f.page, join(home, 'capped.png'));
  assert.equal(result.screenshots.length, 8); assert.equal(result.truncated, true);
  assert.equal(f.calls.some(call => call[0] === 'document-scroll'), false);
  const captures = f.calls.filter(call => call[1] === 'Page.captureScreenshot');
  assert.equal(captures.length, 8);
  const rect = f.root.getBoundingClientRect();
  for (const [, , params] of captures) {
    assert.equal(params.captureBeyondViewport, false);
    assert.ok(params.clip.x >= rect.x && params.clip.y >= rect.y);
    assert.ok(params.clip.x + params.clip.width <= rect.right && params.clip.y + params.clip.height <= rect.bottom);
  }
  const viewport = f.calls.find(call => call[1] === 'Emulation.setDeviceMetricsOverride')[2];
  assert.equal(viewport.height, 4000);
  assert.equal(f.state.viewportHeight, 800);
  assert.equal(f.calls.at(-1)[1], 'Emulation.clearDeviceMetricsOverride');
});

test('reply screenshots use the nearest target-and-editor container and never fall back to the document', async () => {
  const f = fixture({ modal: false });
  const result = await captureThread(f.page, join(home, 'reply.png'), { reply: true, label: 'target', maxImages: 1 });
  assert.equal(result.screenshots.length, 1); assert.equal(result.truncated, false);
  assert.equal(f.calls.some(call => call[0] === 'document-scroll'), false);
  const missing = fixture({ modal: false, noTarget: true });
  await assert.rejects(captureThread(missing.page, join(home, 'missing.png'), { reply: true }), error => error.code === 'UI_CHANGED');
  assert.equal(missing.calls.some(call => call[1] === 'Page.captureScreenshot'), false);
  assert.equal(missing.calls.some(call => call[0] === 'document-scroll'), false);
  await assert.rejects(captureThread(f.page, join(home, 'missing-dialog.png')), error => error.code === 'UI_CHANGED');
});
