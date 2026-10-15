import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';

export function expandHome(p) {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function numberSetting(value, fallback) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toolWaitSetting(value) {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.max(5, Math.min(300, parsed)) : 45;
}

const home = resolve(expandHome(process.env.X_POSTER_HOME || '~/.x-poster'));
export const config = {
  home,
  profileDir: join(home, 'chrome-profile'),
  historyFile: join(home, 'history.jsonl'),
  stateFile: join(home, 'state.json'),
  previewsDir: join(home, 'previews'),
  chromePath: process.env.X_POSTER_CHROME_PATH || null,
  headless: /^(1|true|yes|on)$/i.test(process.env.X_POSTER_HEADLESS || ''),
  foreground: /^(1|true|yes|on)$/i.test(process.env.X_POSTER_FOREGROUND || ''),
  minIntervalSec: numberSetting(process.env.X_POSTER_MIN_INTERVAL_SEC, 60),
  dailyLimit: numberSetting(process.env.X_POSTER_DAILY_LIMIT, 20),
  toolWaitSec: toolWaitSetting(process.env.X_POSTER_TOOL_WAIT_SEC),
  shutdownGraceSec: numberSetting(process.env.X_POSTER_SHUTDOWN_GRACE_SEC, 180),
};

export async function ensureHome() {
  await mkdir(config.home, { recursive: true, mode: 0o700 });
}

export async function loadState() {
  try {
    const value = JSON.parse(await readFile(config.stateFile, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export async function saveState(patch) {
  await ensureHome();
  const state = { ...await loadState(), ...patch };
  const temporary = `${config.stateFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, config.stateFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
