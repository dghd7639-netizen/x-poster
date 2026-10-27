import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, listScheduled, openComposer, SELECTORS } from '../server/x.mjs';
import * as x from '../server/x.mjs';
import { XPosterError } from '../server/errors.mjs';

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
    dispatchEvent(event) { calls.push(['paste']); if (state.paste) state.text += event.clipboardData.value; },
    parentElement: { contains: () => true,
      getBoundingClientRect: () => ({ x: 20, y: 30, right: 420, bottom: 330, width: 400, height: 300 }) },
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    contains: () => false,
  };
  const inlineEditor = { textContent: 'timeline draft', innerText: 'timeline draft' };
  const makeButton = testid => {
    const attributes = { 'data-testid': testid };
    return {
      disabled: false, clicked: 0,
      getAttribute: name => attributes[name] ?? null,
    };
  };
  const button = makeButton(state.inline ? 'tweetButtonInline' : 'tweetButton');
  const backgroundButton = makeButton('tweetButtonInline');
  const diagnosticButton = (testid, label, text, disabled = false) => ({
    innerText: text, disabled,
    getAttribute: name => ({ 'data-testid': testid, 'aria-label': label, 'aria-disabled': 'false' })[name] ?? null,
  });
  const composerButtons = [diagnosticButton('scheduleOption', '预排期', ''),
    diagnosticButton('more', null, '  ' + '很长的按钮文字'.repeat(10) + '  ', true),
    ...Array.from({ length: state.extraButtons ?? 0 }, (_, i) => diagnosticButton(`button-${i}`, null, '额外按钮'))];
  const accountButton = diagnosticButton('accountSwitcher', '@private_account', 'private display name'.repeat(10));
  const testidNode = id => ({ getAttribute: () => id });
  const composerTestids = () => [
    ...(state.missingEditor ? [] : [testidNode('tweetTextarea_0')]), ...composerButtons,
    ...(state.extraTestids ?? []).map(testidNode),
  ];
  const bounds = () => state.diagnosticRect ?? { x: 20, y: 30, right: 420, bottom: 330, width: 400, height: 300 };
  const root = {
    getBoundingClientRect: bounds,
    querySelector: selector => !state.missingButton && selector === `[data-testid=${button.getAttribute('data-testid')}]` ? button : null,
    querySelectorAll: selector => selector === '[data-testid]' ? composerTestids()
      : selector === 'button, [role=button]' ? composerButtons : [],
  };
  editor.closest = () => state.modal ? root : null;
  editor.parentElement.querySelectorAll = root.querySelectorAll;
  editor.parentElement.querySelector = root.querySelector;
  editor.parentElement.getBoundingClientRect = bounds;
  editor.parentElement.parentElement = root;
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
    readyState: 'complete',
    querySelector(selector) {
      if (selector === SELECTORS.dialog) return state.modal || state.unrelatedDialog ? root : null;
      if (selector.endsWith(SELECTORS.editor) && state.missingEditor) return null;
      if (selector.endsWith(SELECTORS.postButton) && state.missingButton) return null;
      if (selector === SELECTORS.scheduleConfirm && state.scheduleDialog) return button;
      if (selector === '[data-testid=emptyState]' && state.empty) return {};
      if (selector === scope + SELECTORS.editor) return editor;
      if (selector === SELECTORS.editor) return inlineEditor;
      if (selector === scope + SELECTORS.postButton && !state.inline) return button;
      if (selector === '[data-testid=tweetButtonInline]') return backgroundButton;
      if (selector === SELECTORS.profileLink) return { getAttribute: () => '/alice' };
      if (selector === SELECTORS.toast && state.toast) return {
        innerText: state.toast, querySelector: () => state.toastHref ? { getAttribute: () => state.toastHref } : null,
      };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === SELECTORS.editor) return state.missingEditor ? []
        : state.modal ? [editor, inlineEditor] : [editor];
      const allTestids = [...composerTestids(), accountButton, ...(state.outsideTestids ?? []).map(testidNode)];
      if (selector === '[data-testid]') return allTestids;
      const match = selector.match(/^\[data-testid="([^"]+)"\]$/);
      if (match) return allTestids.filter(element => element.getAttribute('data-testid') === match[1]);
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
    async ensureRendering() { calls.push(['ensureRendering']); },
    async navigate(url) {
      calls.push(['navigate', url]);
      if (state.listResponse) {
        events.get('Network.responseReceived')?.({ requestId: 'request', response: { url: 'https://x.com/i/api/graphql/hash/FetchScheduledTweets' } });
        events.get('Network.loadingFinished')?.({ requestId: 'request' });
      }
    },
    async call(fn, ...args) {
      calls.push(['call', args]);
      return structuredClone(runInNewContext(`(${fn.toString()})(...args)`, {
        args, document, location: state, DataTransfer, ClipboardEvent, HTMLSelectElement: Select, Event,
        scrollX: state.scrollX ?? 0, scrollY: state.scrollY ?? 0,
        innerWidth: 1200, innerHeight: 800,
      }));
    },
    async waitFor(fn, args = []) { return this.call(fn, ...args); },
    async press(key) {
      calls.push(['press', key]);
      if (key === 'Backspace') state.text = '';
      if (key === 'Enter') state.text += '\n';
    },
    async insertText(text) { calls.push(['insertText', text]); state.text += text; },
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
      const clicked = document.querySelector(selector);
      assert.ok(clicked, `button must exist: ${selector}`);
      assert.equal(clicked.disabled || clicked.getAttribute('aria-disabled') === 'true', false);
      clicked.clicked++;
      state.onSubmit?.();
      if (state.clickError) throw state.clickError;
      if (state.noResponse) return;
      const operation = state.scheduling ? 'CreateScheduledTweet' : 'CreateTweet';
      events.get('Network.responseReceived')?.({ requestId: 'request', response: { url: `https://x.com/i/api/graphql/hash/${operation}` } });
      events.get('Network.loadingFinished')?.({ requestId: 'request' });
    },
    async close() { this.closed = true; },
  };
  return { browser: { newPage: async () => page }, page, state, calls, events, inlineEditor, selects, editor, root,
    composerButtons, diagnosticButton, button, backgroundButton };
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

test('inline-only composer fails before paste, insertText, upload or click in every mode', async t => {
  for (const mode of ['preview', 'post', 'schedule']) {
    for (const unrelatedDialog of [false, true]) {
      const f = fixture({ modal: false, inline: true, unrelatedDialog });
      const args = await input(t, { mode, ...(mode === 'schedule' ? { scheduledAt } : {}) });
      await assert.rejects(compose(f.browser, args), error => {
        assert.equal(error.code, 'UI_CHANGED');
        assert.equal(error.message, '发帖弹窗未出现（页面可能没有渲染），已停止，未输入任何内容。');
        assert.equal(error.details.diagnostics.editor_in_dialog, false);
        return true;
      });
      assert.equal(f.state.text, '');
      assert.equal(f.calls.some(call => ['paste', 'insertText', 'click', 'files'].includes(call[0])), false);
      assert.equal(f.page.closed, true);
    }
  }
});

test('openComposer checks rendering immediately after navigation and keeps modal scope', async () => {
  const f = fixture();
  assert.equal(await openComposer(f.page), '[role=dialog] ');
  assert.deepEqual(f.calls.slice(0, 3).map(call => call[0]), ['navigate', 'ensureRendering', 'call']);
});

test('openComposer preserves a narrow full-page composer with a normal post button', async () => {
  const f = fixture({ modal: false });
  assert.equal(await openComposer(f.page), '');
});

test('openComposer treats rendering recovery errors as non-fatal', async () => {
  const f = fixture();
  f.page.ensureRendering = async () => { throw new Error('CDP unavailable'); };
  assert.equal(await openComposer(f.page), '[role=dialog] ');
});

test('standard dialog post ignores the background inline button', async t => {
  const f = fixture();
  await compose(f.browser, await input(t, { mode: 'post' }));
  assert.equal(f.button.clicked, 1);
  assert.equal(f.backgroundButton.clicked, 0);
});

test('rendering diagnostics contain only frame counts, remedy and visibility', async t => {
  const f = fixture();
  f.page.rendering = { stalled: false, initial_frames: 0, remedy: 'focus_emulation', final_frames: 30,
    visibility: 'visible', private: '@private_account cookie=secret' };
  const diagnostics = await x.captureUIDiagnostics(f.page, (await input(t)).screenshotPath);
  assert.deepEqual(diagnostics.rendering, { initial_frames: 0, remedy: 'focus_emulation', final_frames: 30, visibility: 'visible' });
  assert.doesNotMatch(JSON.stringify(diagnostics), /private_account|cookie=secret/);
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
    assert.equal('diagnostics' in error.details, false);
    return true;
  });
  assert.equal(unknown.page.closed, true);
});

test('login and account challenges are returned without filling or clicking', async t => {
  for (const [pathname, code] of [['/i/flow/login', 'NOT_LOGGED_IN'], ['/account/access', 'ACCOUNT_CHALLENGE']]) {
    const { browser, page, calls } = fixture({ pathname });
    await assert.rejects(compose(browser, await input(t, { submit: true })), error => {
      assert.equal(error.code, code);
      assert.equal('diagnostics' in error.details, false);
      return true;
    });
    assert.equal(calls.some(call => call[0] === 'click' || call[0] === 'files'), false);
    assert.equal(calls.some(call => call[0] === 'screenshot'), false);
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

test('missing post button captures private diagnostics before closing the composer', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now += 20000);
  const f = fixture({ missingButton: true });
  const args = await input(t);
  const path = args.screenshotPath.replace('.png', '-diagnostic.png');
  // An existing file must also end up private.
  await writeFile(path, 'old', { mode: 0o644 });
  const screenshot = f.page.screenshot;
  f.page.screenshot = async clip => { assert.equal(f.page.closed, false); return screenshot(clip); };
  await assert.rejects(compose(f.browser, args), error => {
    assert.equal(error.code, 'UI_CHANGED');
    assert.equal(error.message, '找不到发布按钮。');
    assert.equal(error.hint, undefined);
    assert.equal(error.details.selector, '[role=dialog] [data-testid=tweetButton]');
    const diagnostics = error.details.diagnostics;
    assert.equal(diagnostics.testids.tweetTextarea_0, 1);
    assert.equal(diagnostics.composer_buttons.length, 2);
    assert.deepEqual(diagnostics.viewport, { width: 1200, height: 800 });
    assert.equal(diagnostics.screenshot, path);
    assert.equal(error.toJSON().diagnostics, diagnostics);
    return true;
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path)).toString(), 'mock PNG');
  assert.equal(f.state.text, args.text);
  assert.equal(f.page.closed, true);
  assert.equal(f.calls.some(call => call[0] === 'click'), false);
});

test('diagnostics scope buttons, truncate labels, strip URLs and limit sorted testids', async t => {
  const ids = Array.from({ length: 65 }, (_, i) => `id-${String(i).padStart(2, '0')}`);
  for (const modal of [true, false]) {
    const f = fixture({ modal, search: '?secret=query', hash: '#private',
      extraTestids: [...ids.reverse(), 'frequent', 'frequent', '__proto__'] });
    const diagnostics = await x.captureUIDiagnostics(f.page, (await input(t)).screenshotPath);
    assert.equal(diagnostics.page_path, '/compose/post');
    assert.equal(diagnostics.ready_state, 'complete');
    assert.equal(diagnostics.has_dialog, modal);
    assert.equal(diagnostics.editor_in_dialog, modal);
    assert.equal(diagnostics.editor_present, true);
    assert.equal(Object.keys(diagnostics.testids).length, 60);
    assert.deepEqual(Object.entries(diagnostics.testids).slice(0, 4),
      [['frequent', 2], ['__proto__', 1], ['id-00', 1], ['id-01', 1]]);
    assert.deepEqual(diagnostics.composer_buttons.map(button => button.testid), ['scheduleOption', 'more']);
    assert.equal(diagnostics.composer_buttons[0].label, '预排期');
    assert.equal(diagnostics.composer_buttons[1].disabled, true);
    assert.ok(diagnostics.composer_buttons.every(button => button.label.length <= 24));
    assert.doesNotMatch(JSON.stringify(diagnostics), /private_account|private display name|secret=query|#private|hello/);
    assert.deepEqual(Object.keys(diagnostics).sort(), ['page_path', 'viewport', 'ready_state', 'has_dialog',
      'editor_in_dialog', 'editor_present', 'testids', 'page_testids', 'composer_buttons', 'screenshot', 'captured_at'].sort());
    assert.ok(Number.isFinite(Date.parse(diagnostics.captured_at)));
  }
});

test('diagnostics cap buttons at 30 and stop searching after six ancestors', async t => {
  const args = await input(t);
  const f = fixture({ extraButtons: 40 });
  f.composerButtons[0].getAttribute = name => ({ 'data-testid': 'scheduleOption', 'aria-disabled': 'true' })[name] ?? null;
  const diagnostics = await x.captureUIDiagnostics(f.page, args.screenshotPath);
  assert.equal(diagnostics.composer_buttons.length, 30);
  assert.equal(diagnostics.composer_buttons[0].disabled, true);
  for (const depth of [6, 7]) {
    const g = fixture({ modal: false });
    let parent = g.root;
    for (let i = 1; i < depth; i++) parent = { parentElement: parent, querySelectorAll: () => [] };
    g.editor.parentElement = parent;
    const result = await x.captureUIDiagnostics(g.page, args.screenshotPath);
    assert.equal(result.composer_buttons.length, depth === 6 ? 2 : 0);
  }
});

test('diagnostics mask identities inside the composer and exclude timeline testids', async t => {
  const f = fixture({ extraTestids: ['UserAvatar-Container-alice_demo', 'UserAvatar-Container-bob_demo',
    '555111222-follow', '66777888-follow', '12-follow', 'control-123456-extra-987654321', 'control-12345'],
    outsideTestids: ['UserAvatar-Container-dave_demo', '909090-follow', 'tweetText', 'like', 'retweet', 'trend',
      'primaryColumn', 'primaryColumn', 'tweetButtonInline', 'mask'] });
  f.composerButtons.push(f.diagnosticButton('UserAvatar-Container-carol_demo', '@carol_demo', ''),
    f.diagnosticButton('123456789-follow', 'alice_demo', ''),
    f.diagnosticButton('control-654321-extra-11223344', '发送', ''));
  const diagnostics = await x.captureUIDiagnostics(f.page, (await input(t)).screenshotPath);
  const json = JSON.stringify(diagnostics);
  assert.doesNotMatch(json, /alice_demo|bob_demo|carol_demo|dave_demo|555111222|66777888|909090|123456789|123456|987654321|654321|11223344/);
  assert.equal(diagnostics.testids['UserAvatar-Container-*'], 3);
  assert.equal(diagnostics.testids['*-follow'], 4);
  assert.equal(diagnostics.testids['control-*-extra-*'], 2);
  assert.equal(diagnostics.testids['control-12345'], 1);
  for (const id of ['accountSwitcher', 'tweetText', 'like', 'retweet', 'trend', 'primaryColumn', 'tweetButtonInline', 'mask']) {
    assert.equal(Object.hasOwn(diagnostics.testids, id), false, id);
  }
  assert.deepEqual(diagnostics.page_testids, { tweetTextarea_0: 1, tweetButtonInline: 1,
    scheduleOption: 1, primaryColumn: 2, mask: 1 });
  assert.deepEqual(diagnostics.composer_buttons.slice(-3).map(button => button.testid),
    ['UserAvatar-Container-*', '*-follow', 'control-*-extra-*']);
});

test('diagnostics drop handle-like labels before truncation and preserve known action labels', async t => {
  const f = fixture();
  f.composerButtons.splice(0, f.composerButtons.length,
    f.diagnosticButton('tweetButton', 'Post', ''),
    f.diagnosticButton('tweetButtonInline', 'Reply', ''),
    f.diagnosticButton('custom', 'dave_demo', ''),
    f.diagnosticButton('custom', null, 'carol_demo'),
    f.diagnosticButton('custom', 'x'.repeat(30) + '@private_account', ''),
    f.diagnosticButton('scheduleOption', '@private_account', ''),
    f.diagnosticButton('UserAvatar-Container-display_handle', 'Private Display Name', ''),
    f.diagnosticButton('custom', '更多选项', ''));
  const diagnostics = await x.captureUIDiagnostics(f.page, (await input(t)).screenshotPath);
  assert.doesNotMatch(JSON.stringify(diagnostics), /dave_demo|carol_demo|private_account|display_handle|Private Display Name/);
  assert.deepEqual(diagnostics.composer_buttons.map(button => button.label), ['Post', 'Reply',
    undefined, undefined, undefined, undefined, undefined, '更多选项']);
  for (const button of diagnostics.composer_buttons.slice(2, 7)) assert.equal(Object.hasOwn(button, 'label'), false);
});

test('diagnostic screenshots use the composer rectangle plus margin bounded by the viewport', async t => {
  const args = await input(t);
  for (const [options, expected] of [
    [{}, { x: 8, y: 18, width: 424, height: 324 }],
    [{ modal: false }, { x: 8, y: 18, width: 424, height: 324 }],
    [{ diagnosticRect: { x: -10, y: -5, right: 1195, bottom: 799, width: 1205, height: 804 } },
      { x: 0, y: 0, width: 1200, height: 800 }],
    [{ scrollX: 50, scrollY: 200 }, { x: 58, y: 218, width: 424, height: 324 }],
  ]) {
    const f = fixture(options);
    const diagnostics = await x.captureUIDiagnostics(f.page, args.screenshotPath);
    assert.ok(diagnostics.screenshot);
    assert.deepEqual(f.calls.find(call => call[0] === 'screenshot'), ['screenshot', expected]);
    assert.equal('clip' in diagnostics, false);
  }
});

test('missing composers have only safe page context and fall back to viewport screenshots', async t => {
  const f = fixture({ missingEditor: true, outsideTestids: ['UserAvatar-Container-private_handle', '987654321-follow',
    'primaryColumn', 'SideNav_NewTweet_Button', 'tweetText', 'like'] });
  const diagnostics = await x.captureUIDiagnostics(f.page, (await input(t)).screenshotPath);
  assert.deepEqual(diagnostics.testids, {});
  assert.deepEqual(diagnostics.composer_buttons, []);
  assert.deepEqual(diagnostics.page_testids, { scheduleOption: 1, SideNav_NewTweet_Button: 1, primaryColumn: 1 });
  assert.doesNotMatch(JSON.stringify(diagnostics), /private_handle|987654321|tweetText|like/);
  assert.deepEqual(f.calls.find(call => call[0] === 'screenshot'), ['screenshot', undefined]);
});

test('unmeasurable or offscreen composers never fall back to timeline screenshots', async t => {
  const args = await input(t);
  for (const diagnosticRect of [
    { x: 0, y: 0, right: 0, bottom: 0, width: 0, height: 0 },
    { x: 1300, y: 900, right: 1500, bottom: 1100, width: 200, height: 200 },
    null,
  ]) {
    const f = fixture({ diagnosticRect });
    if (!diagnosticRect) f.root.getBoundingClientRect = () => { throw new Error('layout failed'); };
    const diagnostics = await x.captureUIDiagnostics(f.page, args.screenshotPath);
    assert.equal(diagnostics.editor_present, true);
    assert.equal('screenshot' in diagnostics, false);
    assert.equal(f.calls.some(call => call[0] === 'screenshot'), false);
  }
});

test('editor timeout includes diagnostics directly from openComposer without closing the page', async t => {
  const f = fixture({ missingEditor: true });
  const args = await input(t);
  await assert.rejects(openComposer(f.page, undefined, args.screenshotPath), error => {
    assert.equal(error.code, 'UI_CHANGED');
    assert.equal(error.message, '等待发帖编辑器超时。');
    assert.equal(error.details.diagnostics.editor_present, false);
    assert.deepEqual(error.details.diagnostics.composer_buttons, []);
    assert.match(error.details.diagnostics.screenshot, /-diagnostic\.png$/);
    return true;
  });
  assert.equal(f.page.closed, false);
  const g = fixture({ missingEditor: true });
  await assert.rejects(compose(g.browser, args), error => error.details.diagnostics.editor_present === false);
  assert.equal(g.calls.filter(call => call[0] === 'screenshot').length, 1, 'openComposer diagnostics must not be captured twice');
  assert.equal(g.page.closed, true);
});

test('failed diagnostics preserve the original submit error and all its details', async t => {
  const original = new XPosterError('UI_CHANGED', '找不到页面按钮。', { selector: SELECTORS.postButton, hint: '原有提示', extra: 42 });
  const f = fixture({ clickError: original, onSubmit: () => {
    f.page.call = () => { throw new Error('Runtime.evaluate failed'); };
    f.page.screenshot = () => { throw new Error('Page.captureScreenshot failed'); };
  } });
  await assert.rejects(compose(f.browser, await input(t, { submit: true })), error => {
    assert.equal(error, original);
    assert.deepEqual(error.toJSON(), { code: 'UI_CHANGED', message: '找不到页面按钮。', hint: '原有提示',
      selector: SELECTORS.postButton, extra: 42, diagnostics: null });
    return true;
  });
  assert.equal(f.page.closed, true);
  assert.equal(f.events.size, 0);
  assert.equal(f.calls.filter(call => call[0] === 'click').length, 1);
});

test('post and schedule click UI_CHANGED trigger only read-only diagnostics without retry', async t => {
  for (const mode of ['post', 'schedule']) {
    const original = new XPosterError('UI_CHANGED', '找不到发布按钮。', { selector: SELECTORS.postButton });
    const f = fixture({ clickError: original });
    const args = await input(t, { mode, ...(mode === 'schedule' ? { scheduledAt } : {}) });
    await assert.rejects(compose(f.browser, args), error => {
      assert.equal(error, original);
      assert.ok(error.details.diagnostics.screenshot);
      return true;
    });
    const lastClick = f.calls.findLastIndex(call => call[0] === 'click');
    assert.deepEqual(f.calls.slice(lastClick + 1).map(call => call[0]), ['call', 'screenshot']);
    assert.equal(f.calls.filter(call => call[0] === 'click' && call[1].endsWith(SELECTORS.postButton)).length, 1);
    assert.equal(f.events.size, 0);
    assert.equal(f.page.closed, true);
  }
});

test('diagnostics retain partial results when evaluation, screenshot or writing fails', async t => {
  const args = await input(t);
  const f = fixture();
  f.page.call = async () => { throw new Error('evaluate'); };
  const screenshotOnly = await x.captureUIDiagnostics(f.page, args.screenshotPath);
  assert.deepEqual(Object.keys(screenshotOnly).sort(), ['captured_at', 'screenshot']);
  const g = fixture();
  g.page.screenshot = async () => { throw new Error('screenshot'); };
  const domOnly = await x.captureUIDiagnostics(g.page, args.screenshotPath);
  assert.equal(domOnly.editor_present, true);
  assert.equal('screenshot' in domOnly, false);
  const writeFailure = await x.captureUIDiagnostics(fixture().page, join(args.screenshotPath, 'missing.png'));
  assert.equal(writeFailure.editor_present, true);
  assert.equal('screenshot' in writeFailure, false);
});

test('hanging diagnostic steps respect the total time limit with fake timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const f = fixture();
  f.page.call = () => new Promise(() => {});
  f.page.screenshot = () => new Promise(() => {});
  let done = false;
  const result = x.captureUIDiagnostics(f.page, '/tmp/hang.png').then(value => { done = true; return value; });
  await flush();
  for (let i = 0; i < 10 && !done; i++) {
    t.mock.timers.tick(500);
    await flush();
  }
  assert.equal(done, true, 'diagnostics must finish within 5 seconds');
  assert.equal(await result, null);
  assert.ok(Date.now() - 1000 <= 5000);
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
