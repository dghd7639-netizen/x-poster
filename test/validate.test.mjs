import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePostInput, weightedLength } from '../server/validate.mjs';

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
