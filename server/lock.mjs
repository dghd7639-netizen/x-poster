import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { XPosterError } from './errors.mjs';

const held = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;
const CORRUPT_AGE_MS = 10000;

export function holdsLock(path) {
  const owner = held.get(path);
  if (!owner) return false;
  try { return statSync(path).ino === owner.ino && readFileSync(path, 'utf8') === owner.content; }
  catch { return false; }
}

let exitRegistered = false;
function releaseOnExit() {
  for (const [path, owner] of held) {
    try {
      if (statSync(path).ino === owner.ino && readFileSync(path, 'utf8') === owner.content) unlinkSync(path);
    } catch { /* The lock may already have been released or replaced. */ }
  }
}

async function snapshot(path) {
  let info;
  try { info = await stat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return { info, content: await readFile(path, 'utf8') }; }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    return { info, unreadable: error.code };
  }
}

function stale(lock) {
  let value;
  try { value = JSON.parse(lock.content); } catch { /* Treat incomplete writes as corrupt. */ }
  const started = Date.parse(value?.started_at);
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || !Number.isFinite(started)) {
    return Date.now() - lock.info.mtimeMs > CORRUPT_AGE_MS;
  }
  if (Date.now() - started > MAX_AGE_MS) return true;
  try { process.kill(value.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  return false;
}

async function removeIfUnchanged(path, previous) {
  const current = await snapshot(path);
  if (current && current.info.ino === previous.info.ino && current.info.mtimeMs === previous.info.mtimeMs
    && current.info.size === previous.info.size && current.content === previous.content && current.unreadable === previous.unreadable) {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function acquireLock(path, { tool = 'browser', signal, onWait } = {}) {
  // Register after Chrome's handler so owned browser cleanup precedes releasing its operation lock.
  if (!exitRegistered) { process.on('exit', releaseOnExit); exitRegistered = true; }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (;;) {
      signal?.throwIfAborted();
      let file;
      try { file = await open(path, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lock = await snapshot(path);
        if (!lock) continue;
        if (stale(lock)) { await removeIfUnchanged(path, lock); continue; }
        onWait?.();
        await delay(250, undefined, { signal });
        continue;
      }
      const content = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), tool });
      const info = await file.stat();
      try { await file.writeFile(content); }
      catch (error) {
        const partial = await snapshot(path);
        if (partial?.info.ino === info.ino) await removeIfUnchanged(path, partial);
        throw error;
      } finally { await file.close(); }
      const owner = { content, ino: info.ino };
      held.set(path, owner);
      const release = async () => {
        const current = await snapshot(path);
        if (current?.info.ino === owner.ino && current.content === content) await removeIfUnchanged(path, current);
        if (held.get(path) === owner) held.delete(path);
      };
      if (signal?.aborted) { await release(); signal.throwIfAborted(); }
      return release;
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof XPosterError) throw error;
    throw new XPosterError('INTERNAL_ERROR', '无法访问浏览器任务锁。', { hint: '请检查 X_POSTER_HOME 目录权限。' });
  }
}
