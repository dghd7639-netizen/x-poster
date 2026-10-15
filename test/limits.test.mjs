import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRateLimit, readHistory, appendHistory } from '../server/limits.mjs';

const now = Date.parse('2026-10-14T12:00:00Z');
const entry = ago => ({ ts: new Date(now - ago * 1000).toISOString() });
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
