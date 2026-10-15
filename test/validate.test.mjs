import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePostInput, weightedLength, parseScheduledAt } from '../server/validate.mjs';

test('weighted length follows URLs, NFC and grapheme rules', () => {
  for (const [text, length] of [
    ['hello', 5], ['你好', 4], ['hello https://example.com/a/very/long/path', 29],
    ['🚀', 2], ['👨\u200D👩\u200D👧', 2], ['👍🏽', 2], ['🇨🇳', 2], ['1\uFE0F\u20E3', 2], ['e\u0301', 1],
  ]) assert.equal(weightedLength(text), length, text);
});

test('invalid post inputs fail before browser work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-validation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const large = join(dir, 'large.png');
  await writeFile(large, '');
  await truncate(large, 5 * 1024 * 1024 + 1);
  const inputs = [undefined, {}, { text: ' \r\n ' }, { text: 42 }, { images: 'x' },
    { images: Array(5).fill('/a.png') }, { images: ['image.png'] },
    { images: [join(dir, 'a.svg')] }, { images: [join(dir, 'missing.png')] },
    { images: [large] }, { images: [''] }, { images: [null] }, null];
  for (const input of inputs) {
    await assert.rejects(validatePostInput(input), error => error.code === 'INVALID_INPUT');
  }
});

test('valid PNG uses absolute paths and normalizes CRLF and CR', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'x-poster-validation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'image.png');
  await writeFile(file, 'image');
  assert.deepEqual(await validatePostInput({ text: ' hi\r\n你好\r世界 ', images: [file] }), {
    text: 'hi\n你好\n世界', images: [file], weightedLength: 12,
  });
  assert.equal((await validatePostInput({ images: [file] })).text, '');
  assert.equal((await validatePostInput({ text: 'a'.repeat(281) })).weightedLength, 281);
});


test('scheduled times preserve local components and convert explicit offsets', () => {
  const now = new Date(2026, 9, 15, 8);
  const local = parseScheduledAt('2026-10-16T09:07', now);
  assert.equal(local.date.getTime(), new Date(2026, 9, 16, 9, 7).getTime());
  assert.deepEqual(local.components, { year: 2026, month: 10, day: 16, hour: 9, minute: 7 });
  for (const value of ['2026-10-16T09:07:00+08:00', '2026-10-16T01:07:00Z']) {
    const parsed = parseScheduledAt(value, now);
    assert.equal(parsed.date.getTime(), Date.parse('2026-10-16T01:07:00Z'));
    assert.equal(parsed.components.hour, parsed.date.getHours());
    assert.equal(parsed.components.day, parsed.date.getDate());
  }
  assert.doesNotThrow(() => parseScheduledAt('2026-10-15T08:05', now));
  assert.doesNotThrow(() => parseScheduledAt('2026-10-16T09:00:00.123456', now));
  assert.doesNotThrow(() => parseScheduledAt('2028-12-31T09:00', now));
});

test('invalid scheduled times fail with INVALID_INPUT', () => {
  const now = new Date(2026, 9, 15, 8);
  for (const value of [undefined, null, 42, '', 'garbage', '2026-10-16',
    '2026-10-14T09:00', '2026-10-15T08:04:59', '2029-01-01T09:00',
    '2026-02-30T09:00', '2026-13-01T09:00', '2026-10-16T25:00', '2026-10-16T09:00+24:00']) {
    assert.throws(() => parseScheduledAt(value, now), error => error.code === 'INVALID_INPUT', String(value));
  }
});


test('scheduled components follow the local date when offsets cross midnight', () => {
  const expected = new Date(2026, 9, 16, 0, 7);
  const parsed = parseScheduledAt(expected.toISOString(), new Date(2026, 9, 15));
  assert.deepEqual(parsed.components, { year: 2026, month: 10, day: 16, hour: 0, minute: 7 });
});
