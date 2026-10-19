import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readHistory(file) {
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const history = [];
  for (const line of contents.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) history.push(entry);
    } catch { /* Interrupted writes must not hide valid history lines. */ }
  }
  return history;
}

export async function appendHistory(file, entry) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function checkRateLimit(history, { minIntervalSec, dailyLimit, count = 1, now = Date.now() }) {
  const entries = history.filter(entry => !entry.cancelled_scheduled && !entry.deleted_article
    && (entry.id || entry.ids?.length || entry.article_id || entry.scheduled_for || entry.uncertain === true
      || typeof entry.text === 'string' && Number.isInteger(entry.images)))
    .map(entry => ({ time: Date.parse(entry.ts), count: Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1 }))
    .filter(entry => Number.isFinite(entry.time)).sort((a, b) => a.time - b.time);
  const last = entries.at(-1)?.time;
  const day = 24 * 60 * 60 * 1000;
  const recent = entries.filter(entry => entry.time > now - day);
  const postsLast24h = recent.reduce((sum, entry) => sum + entry.count, 0);
  let wait = minIntervalSec > 0 && last !== undefined ? last + minIntervalSec * 1000 - now : 0;
  let excess = dailyLimit > 0 ? postsLast24h + count - dailyLimit : 0;
  const overLimit = excess > 0;
  for (const entry of recent) {
    if (excess <= 0) break;
    wait = Math.max(wait, entry.time + day - now);
    excess -= entry.count;
  }
  const retryAfterSec = Math.max(0, Math.ceil(wait / 1000));
  return {
    allowed: retryAfterSec === 0 && !overLimit,
    retryAfterSec,
    postsLast24h,
    lastPostAt: last === undefined ? null : new Date(last).toISOString(),
  };
}
