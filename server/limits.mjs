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

export function checkRateLimit(history, { minIntervalSec, dailyLimit, now = Date.now() }) {
  const times = history.filter(entry => !entry.cancelled_scheduled && !entry.deleted_article
    && (entry.id || entry.article_id || entry.scheduled_for || entry.uncertain === true
      || typeof entry.text === 'string' && Number.isInteger(entry.images)))
    .map(entry => Date.parse(entry.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  const last = times.at(-1);
  const day = 24 * 60 * 60 * 1000;
  const recent = times.filter(time => time > now - day);
  let wait = minIntervalSec > 0 && last !== undefined ? last + minIntervalSec * 1000 - now : 0;
  if (dailyLimit > 0 && recent.length >= dailyLimit) {
    const index = Math.max(0, Math.floor(recent.length - dailyLimit));
    wait = Math.max(wait, recent[index] + day - now);
  }
  const retryAfterSec = Math.max(0, Math.ceil(wait / 1000));
  return {
    allowed: retryAfterSec === 0,
    retryAfterSec,
    postsLast24h: recent.length,
    lastPostAt: last === undefined ? null : new Date(last).toISOString(),
  };
}
