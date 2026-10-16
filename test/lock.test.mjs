import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, utimes, unlink, access } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, holdsLock } from '../server/lock.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'x-poster-lock-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return join(home, 'browser.lock');
}

function owner(age = 0, pid = process.pid) {
  return JSON.stringify({ pid, started_at: new Date(Date.now() - age).toISOString(), tool: 'fixture' });
}

test('lock creation is private, records ownership, and releases idempotently', { timeout: 1000 }, async t => {
  const path = await fixture(t);
  const release = await acquireLock(path, { tool: 'x_post' });
  assert.equal(holdsLock(path), true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    pid: process.pid, started_at: JSON.parse(await readFile(path, 'utf8')).started_at, tool: 'x_post',
  });
  assert.ok(Number.isFinite(Date.parse(JSON.parse(await readFile(path, 'utf8')).started_at)));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await release();
  await release();
  assert.equal(holdsLock(path), false);
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('a second holder polls and acquires only after release', { timeout: 1500 }, async t => {
  const path = await fixture(t);
  const release = await acquireLock(path);
  let waiting;
  const blocked = new Promise(resolve => { waiting = resolve; });
  let acquired = false;
  const next = acquireLock(path, { onWait: waiting }).then(value => { acquired = true; return value; });
  await blocked;
  assert.equal(acquired, false);
  await release();
  const releaseNext = await next;
  assert.equal(acquired, true);
  await releaseNext();
});

for (const kind of ['dead pid', 'over-age', 'corrupt', 'invalid pid']) {
  test(`reclaims a stale ${kind} lock`, { timeout: 1000 }, async t => {
    const path = await fixture(t);
    const deadPid = 999999;
    assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
    const content = kind === 'dead pid' ? owner(0, deadPid)
      : kind === 'over-age' ? owner(3600001)
      : kind === 'invalid pid' ? owner(0, -1) : '{broken';
    await writeFile(path, content);
    if (kind === 'corrupt' || kind === 'invalid pid') {
      const old = new Date(Date.now() - 10001);
      await utimes(path, old, old);
    }
    const release = await acquireLock(path);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
    await release();
  });
}

test('fresh corrupt locks and EPERM owners are left alone until cancelled', { timeout: 1000 }, async t => {
  const path = await fixture(t);
  for (const content of ['{incomplete', owner()]) {
    await writeFile(path, content);
    const controller = new AbortController();
    let waited = false;
    const killed = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    const reason = new Error('cancelled');
    const pending = acquireLock(path, { signal: controller.signal, onWait: () => {
      waited = true;
      controller.abort(reason);
    } });
    await assert.rejects(pending, error => error === reason);
    assert.equal(waited, true);
    assert.equal(await readFile(path, 'utf8'), content);
    killed.mock.restore();
    await unlink(path);
  }
});

test('release preserves a replacement lock', { timeout: 1000 }, async t => {
  const path = await fixture(t);
  const release = await acquireLock(path);
  await writeFile(path, owner(100));
  assert.equal(holdsLock(path), false);
  const replacement = await readFile(path, 'utf8');
  await release();
  assert.equal(await readFile(path, 'utf8'), replacement);
});

test('real child holder releases after one second and parent acquires afterwards', { timeout: 3000 }, async t => {
  const path = await fixture(t);
  const module = new URL('../server/lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireLock } from ${JSON.stringify(module)};
    const release = await acquireLock(process.argv[1], { tool: 'child' });
    process.send('locked');
    setTimeout(async () => { await release(); process.disconnect(); }, 1000);
  `, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  await once(child, 'message');
  const start = performance.now();
  const release = await acquireLock(path);
  assert.ok(performance.now() - start >= 800);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
  await release();
  assert.equal((await exited)[0], 0);
});

test('normal process exit synchronously removes its held lock', { timeout: 1000 }, async t => {
  const path = await fixture(t);
  const module = new URL('../server/lock.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireLock } from ${JSON.stringify(module)};
    await acquireLock(process.argv[1]);
    process.exit(0);
  `, path], { encoding: 'utf8', timeout: 750 });
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('unreadable locks older than ten seconds can be reclaimed', { timeout: 1000 }, async t => {
  const path = await fixture(t);
  await writeFile(path, owner());
  const old = new Date(Date.now() - 10001);
  await utimes(path, old, old);
  const { default: fs } = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.readFile;
  const mocked = t.mock.method(fs, 'readFile', async (...args) => {
    if (args[0] === path) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const release = await acquireLock(path);
  mocked.mock.restore();
  syncBuiltinESMExports();
  assert.equal(holdsLock(path), true);
  await release();
});

test('stale reclamation re-reads and preserves changed lock content', { timeout: 1000 }, async t => {
  const path = await fixture(t);
  await writeFile(path, owner(3600001));
  const replacement = owner();
  const { default: fs } = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.readFile;
  let reads = 0;
  const mocked = t.mock.method(fs, 'readFile', async (...args) => {
    if (args[0] === path && ++reads === 2) await writeFile(path, replacement);
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const controller = new AbortController();
  const reason = new Error('replacement is still held');
  await assert.rejects(acquireLock(path, { signal: controller.signal, onWait: () => controller.abort(reason) }), error => error === reason);
  assert.ok(reads >= 3);
  assert.equal(await readFile(path, 'utf8'), replacement);
});

test('exit cleanup does not unlink a replacement owned by another holder', { timeout: 1000 }, async t => {
  const path = await fixture(t);
  const module = new URL('../server/lock.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireLock } from ${JSON.stringify(module)};
    import { writeFile } from 'node:fs/promises';
    await acquireLock(process.argv[1]);
    await writeFile(process.argv[1], JSON.stringify({ pid: process.ppid, started_at: new Date().toISOString(), tool: 'replacement' }));
    process.exit(0);
  `, path], { encoding: 'utf8', timeout: 750 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).tool, 'replacement');
});
