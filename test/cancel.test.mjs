import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../server/chrome.mjs';
import { config } from '../server/config.mjs';
import { readHistory, appendHistory, checkRateLimit } from '../server/limits.mjs';
import { cancelScheduled as cancelTool, callTool } from '../server/tools.mjs';
import { cancelScheduled, SELECTORS } from '../server/x.mjs';

const entries = [
  { rest_id: '2', scheduling_info: { execute_at: 1792458000000, state: 'Scheduled' }, tweet_create_request: { status: 'later', media_ids: [] } },
  { rest_id: '1', scheduling_info: { execute_at: 1792371600000, state: 'Scheduled' }, tweet_create_request: { status: 'earlier', media_ids: [] } },
];

function fixture(options = {}) {
  const state = { before: entries, after: [entries[1]], checks: 'input', editing: false, confirming: false, navigations: 0,
    selected: new Set(), ...options };
  const calls = [];
  const handlers = new Map();
  const attributes = new Map();
  const bodies = new Map();
  const tag = element => (name, value) => attributes.set(value, element);
  const edit = { get innerText() { return state.editing ? (state.english ? 'Done' : '完成') : (state.english ? 'Edit' : '编辑'); }, setAttribute: (...args) => tag(edit)(...args) };
  const remove = { get innerText() { return state.english ? 'Delete' : '删除'; }, setAttribute: (...args) => tag(remove)(...args) };
  const items = state.before.map((entry, index) => {
    const checkbox = {
      get checked() { return state.selected.has(index); },
      matches: selector => selector === 'input[type=checkbox]' && state.checks === 'input',
      getAttribute: () => state.selected.has(index) ? 'true' : 'false',
    };
    const label = { matches: () => false, querySelector: () => state.checks === 'none' ? null : checkbox };
    const item = {
      index,
      closest: () => label,
      querySelector: selector => selector === SELECTORS.tweetText
        ? { innerText: state.texts?.[index] ?? entry.tweet_create_request.status } : null,
      setAttribute: (...args) => tag(item)(...args),
    };
    return item;
  });
  const dialog = {
    querySelectorAll: selector => selector === SELECTORS.unsentTweet
      ? items.slice(0, state.domCount ?? items.length) : state.editing ? [edit, remove] : [edit],
  };
  const document = {
    querySelectorAll: selector => selector === SELECTORS.dialog ? [{}, dialog] : [],
    querySelector: selector => selector === SELECTORS.deleteConfirm && state.confirming ? {} : null,
  };
  const emit = (method, value) => { for (const handler of [...(handlers.get(method) ?? [])]) handler(value); };
  const response = (operation, body) => {
    const requestId = String(bodies.size);
    bodies.set(requestId, JSON.stringify(body));
    emit('Network.responseReceived', { requestId, response: { url: `https://x.com/i/api/graphql/hash/${operation}` } });
    emit('Network.loadingFinished', { requestId });
  };
  const page = {
    closed: false,
    async send(method, args) {
      calls.push(['send', method]);
      return method === 'Network.getResponseBody' ? { body: bodies.get(args.requestId) } : {};
    },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method).delete(handler);
    },
    async navigate(url) {
      calls.push(['navigate', url]);
      state.navigations++;
      if (state.navigations > 1 && state.verifyFailure) throw new Error('verification navigation failed');
      response('FetchScheduledTweets', state.navigations > 1 && state.afterBody ? state.afterBody
        : { data: { viewer: { scheduled_tweet_list: state.navigations === 1 ? state.before : state.after } } });
    },
    async call(fn, ...args) {
      return runInNewContext(`(${fn.toString()})(...args)`, { args, document });
    },
    async waitFor(fn, args) { return this.call(fn, ...args); },
    async click(selector) {
      calls.push(['click', selector]);
      if (selector === SELECTORS.deleteConfirm) {
        state.onConfirm?.();
        if (!state.noDeleteResponse) response('DeleteScheduledTweet', { data: { deleted: true } });
        return;
      }
      const element = attributes.get(selector.match(/="(.*?)"/)?.[1]);
      assert.ok(element, `click must use a tagged element: ${selector}`);
      if (element === edit) {
        state.editing = true;
        if (state.afterEditTexts) state.texts = state.afterEditTexts;
      } else if (element === remove) state.confirming = true;
      else {
        assert.equal(state.editing, true, 'items must never be clicked outside edit mode');
        if (state.wrongSelection) state.selected = new Set(state.wrongSelection);
        else state.selected.has(element.index) ? state.selected.delete(element.index) : state.selected.add(element.index);
      }
    },
    async close() { this.closed = true; },
  };
  return { state, calls, page, browser: { newPage: async () => page }, listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0) };
}

test('cancel text mismatch and count mismatch abort before any selection or delete click', async () => {
  for (const options of [{ texts: ['wrong', 'earlier'] }, { domCount: 1 }]) {
    const f = fixture(options);
    await assert.rejects(cancelScheduled(f.browser, '2'), error => error.code === 'UI_CHANGED');
    assert.equal(f.calls.some(call => call[0] === 'click'), false);
    assert.equal(f.page.closed, true);
    assert.equal(f.listeners(), 0);
  }
});

test('missing id and duplicate text/time are rejected without touching UI', async () => {
  for (const [options, id] of [[{}, '3'], [{ before: [entries[0], { ...entries[0], rest_id: '3' }] }, '2']]) {
    const f = fixture(options);
    await assert.rejects(cancelScheduled(f.browser, id), error => error.code === 'INVALID_INPUT');
    assert.equal(f.calls.some(call => call[0] === 'click'), false);
    assert.equal(f.page.closed, true);
  }
});

test('cancel uses response order, enters edit mode and verifies all remaining ids', async () => {
  const f = fixture({ after: [entries[0]] });
  assert.deepEqual(await cancelScheduled(f.browser, '1'), { id: '1', deleted: true, remaining: 1 });
  assert.deepEqual([...f.state.selected], [1]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'click').map(call => call[1]), [
    '[data-x-poster-cancel="edit"]', '[data-x-poster-cancel="target"]', '[data-x-poster-cancel="delete"]', SELECTORS.deleteConfirm,
  ]);
  assert.equal(f.state.navigations, 2);
  assert.equal(f.listeners(), 0);
  assert.equal(f.page.closed, true);
});

test('cancel permits missing checkboxes and supports aria checkbox state', async () => {
  for (const checks of ['none', 'aria']) {
    const f = fixture({ checks, english: checks === 'aria' });
    assert.equal((await cancelScheduled(f.browser, '2')).deleted, true);
    assert.equal(f.listeners(), 0);
  }
});

test('default selection, wrong selection and changed edit-mode text stop before deletion', async () => {
  for (const options of [{ selected: new Set([1]) }, { wrongSelection: [1] }, { wrongSelection: [0, 1] }, { afterEditTexts: ['changed', 'earlier'] }]) {
    const f = fixture(options);
    await assert.rejects(cancelScheduled(f.browser, '2'), error => error.code === 'UI_CHANGED');
    assert.equal(f.calls.some(call => call[1] === '[data-x-poster-cancel="delete"]' || call[1] === SELECTORS.deleteConfirm), false);
    assert.equal(f.page.closed, true);
  }
});

test('cancel returns UNCERTAIN when target remains, others vanish or verification fails', async () => {
  for (const options of [{ after: entries }, { after: [] }, { verifyFailure: true }, { afterBody: { data: {} } }, { after: [{ ...entries[0], scheduling_info: {} }, entries[1]] }]) {
    const f = fixture(options);
    await assert.rejects(cancelScheduled(f.browser, '2'), error => error.code === 'UNCERTAIN');
    assert.equal(f.calls.filter(call => call[1] === SELECTORS.deleteConfirm).length, 1);
    assert.equal(f.listeners(), 0);
    assert.equal(f.page.closed, true);
  }
});

test('cancel can verify success even when no DeleteScheduledTweet response appears', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let confirmed;
  const clicked = new Promise(resolve => { confirmed = resolve; });
  const f = fixture({ noDeleteResponse: true, onConfirm: confirmed });
  const action = cancelScheduled(f.browser, '2');
  await clicked;
  t.mock.timers.tick(10000);
  assert.equal((await action).deleted, true);
  assert.equal(f.listeners(), 0);
});


async function historyFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-cancel-'));
  const original = config.historyFile;
  config.historyFile = join(dir, 'history.jsonl');
  t.after(async () => { config.historyFile = original; await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('cancel tool records verified deletion without consuming posting limits', async t => {
  await historyFixture(t);
  const now = Date.now();
  const oldPost = { ts: new Date(now - 120000).toISOString(), id: '999' };
  await appendHistory(config.historyFile, oldPost);
  const f = fixture();
  let closed = false;
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => true, newPage: async () => f.page, close: async () => { closed = true; } }));
  assert.deepEqual((await cancelTool({ id: '2' })).data, { ok: true, id: '2', deleted: true, remaining: 1 });
  const history = await readHistory(config.historyFile);
  assert.equal(history.length, 2);
  assert.equal(history[1].cancelled_scheduled, '2');
  assert.deepEqual(Object.keys(history[1]).sort(), ['cancelled_scheduled', 'ts']);
  const limits = { now: Date.now(), minIntervalSec: 60, dailyLimit: 20 };
  assert.deepEqual(checkRateLimit(history, limits), checkRateLimit([oldPost], limits));
  assert.equal(closed, true);
  assert.equal(f.page.closed, true);
});

test('uncertain cancellation is not recorded as successful and is never retried', async t => {
  await historyFixture(t);
  const f = fixture({ after: entries });
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => true, newPage: async () => f.page, close: async () => {} }));
  const result = await callTool('x_cancel_scheduled', { id: '2' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, 'UNCERTAIN');
  assert.deepEqual(await readHistory(config.historyFile), []);
  assert.equal(f.calls.filter(call => call[1] === SELECTORS.deleteConfirm).length, 1);
});

test('history failure after verified cancellation remains UNCERTAIN', async t => {
  config.historyFile = await historyFixture(t);
  const f = fixture();
  t.mock.method(console, 'error', () => {});
  t.mock.method(Browser, 'open', async () => ({ isLoggedIn: async () => true, newPage: async () => f.page, close: async () => {} }));
  await assert.rejects(cancelTool({ id: '2' }), error => error.code === 'UNCERTAIN' && /历史记录/.test(error.message));
  assert.equal(f.page.closed, true);
});
