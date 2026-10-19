import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRateLimit, readHistory, appendHistory } from '../server/limits.mjs';

const now = Date.parse('2026-10-14T12:00:00Z');
const entry = ago => ({ ts: new Date(now - ago * 1000).toISOString(), id: '123' });
const check = (history, options = {}) => checkRateLimit(history, { now, minIntervalSec: 60, dailyLimit: 20, ...options });

test('empty history is allowed', () => {
  assert.deepEqual(check([]), { allowed: true, retryAfterSec: 0, postsLast24h: 0, lastPostAt: null });
});
test('interval waits for the remaining 30 seconds', () => {
  assert.deepEqual(check([entry(30)]), {
    allowed: false, retryAfterSec: 30, postsLast24h: 1, lastPostAt: entry(30).ts,
  });
});
test('daily wait expires when the relevant oldest post leaves the window', () => {
  const history = Array.from({ length: 20 }, (_, i) => entry(3600 + i * 100));
  assert.equal(check(history).retryAfterSec, 86400 - 5500);
  assert.equal(check(history).allowed, false);
  const extra = [...history, entry(6000)];
  assert.equal(check(extra).retryAfterSec, 86400 - 5500);
});
test('zero limits disable rules and invalid times are ignored', () => {
  const history = Array.from({ length: 21 }, () => entry(1));
  assert.equal(check(history, { minIntervalSec: 0, dailyLimit: 0 }).allowed, true);
  assert.equal(check([entry(86400), { ts: 'broken' }]).postsLast24h, 0);
  assert.equal(check([{ ts: 'broken' }]).lastPostAt, null);
  assert.equal(check([entry(30), { ...entry(20), uncertain: true }]).retryAfterSec, 40);
});
test('history round trips and skips malformed lines', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'nested', 'history.jsonl');
  assert.deepEqual(await readHistory(file), []);
  await appendHistory(file, entry(30));
  await appendFile(file, 'broken\nnull\n[]\n');
  await appendHistory(file, entry(10));
  assert.deepEqual(await readHistory(file), [entry(30), entry(10)]);
});


test('cancellations and unrelated history never count toward posting limits', () => {
  const cancellations = Array.from({ length: 30 }, (_, i) => ({ ts: entry(i).ts, cancelled_scheduled: '123' }));
  const unrelated = [{ ts: entry(0).ts }, { ts: entry(0).ts, event: 'status' }];
  assert.deepEqual(check([...cancellations, ...unrelated]), check([]));
  assert.deepEqual(check([entry(30), ...cancellations, ...unrelated]), check([entry(30)]));
  const uncertain = { ts: entry(20).ts, uncertain: true, text: 'draft', images: 0 };
  const scheduled = { ts: entry(10).ts, id: '456', scheduled_for: '2026-10-20T09:00:00+08:00' };
  assert.equal(check([uncertain, scheduled, ...cancellations]).postsLast24h, 2);
  assert.equal(check([uncertain, scheduled, ...cancellations]).retryAfterSec, 50);
});

test('article publications count while draft deletions never consume limits or erase publication usage', () => {
  const published = { ts: entry(30).ts, article_id: '123', url: 'https://x.com/me/article/123' };
  const deletions = Array.from({ length: 30 }, (_, i) => ({ ts: entry(i).ts, deleted_article: '123' }));
  assert.deepEqual(check(deletions), check([]));
  assert.deepEqual(check([published, ...deletions]), check([entry(30)]));
  assert.equal(check([{ ts: entry(10).ts, article_id: '456', uncertain: true }]).retryAfterSec, 50);
  assert.equal(check([...Array(20).fill(published), ...deletions]).allowed, false);
});

test('thread counts sum with legacy singles and uncertain history', () => {
  const history = [entry(500), { ...entry(400), count: 5, ids: ['1', '2', '3', '4', '5'] },
    { ts: entry(300).ts, count: 3, uncertain: true, posted_ids: ['6'] }];
  assert.equal(check(history).postsLast24h, 9);
  assert.equal(check(history, { count: 12 }).allowed, false);
  assert.equal(check(history, { count: 11 }).allowed, true);
  assert.equal(check([{ ...entry(10), count: 5 }], { count: 3 }).retryAfterSec, 50);
  assert.equal(check([{ ...entry(90000), count: 25 }]).postsLast24h, 0);
});

test('weighted daily limit waits until enough whole operations expire', () => {
  const history = [{ ...entry(80000), count: 2 }, { ...entry(70000), count: 4 }, { ...entry(60000), count: 3 }];
  const rate = check(history, { dailyLimit: 10, count: 5 });
  assert.equal(rate.allowed, false); assert.equal(rate.postsLast24h, 9);
  assert.equal(rate.retryAfterSec, 86400 - 70000);
  assert.equal(check(history, { dailyLimit: 0, minIntervalSec: 0, count: 25 }).allowed, true);
  assert.equal(check([], { dailyLimit: 20, count: 25 }).allowed, false);
});
