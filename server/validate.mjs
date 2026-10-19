import { isAbsolute, resolve, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { expandHome } from './config.mjs';
import { XPosterError } from './errors.mjs';

export const MAX_WEIGHTED_LENGTH = 280;
export const MAX_IMAGES = 4;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;

export function weightedLength(text) {
  let length = 0;
  const rest = text.normalize('NFC').replace(/https?:\/\/\S+/g, () => {
    length += 23;
    return '';
  });
  for (const { segment } of segmenter.segment(rest)) {
    if (emoji.test(segment)) {
      length += 2;
      continue;
    }
    for (const char of segment) {
      const cp = char.codePointAt(0);
      length += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d)
        || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
    }
  }
  return length;
}

export async function validatePostInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new XPosterError('INVALID_INPUT', '发帖参数必须是对象。');
  }
  let { text, images } = input;
  if (text != null && typeof text !== 'string') {
    throw new XPosterError('INVALID_INPUT', '文字必须是字符串。');
  }
  if (images != null && !Array.isArray(images)) {
    throw new XPosterError('INVALID_INPUT', '图片必须是路径数组。');
  }
  text = (text ?? '').replace(/\r\n?/g, '\n').trim();
  images ??= [];
  if (!text && images.length === 0) {
    throw new XPosterError('INVALID_INPUT', '请至少提供文字或一张图片。');
  }
  if (images.length > MAX_IMAGES) {
    throw new XPosterError('INVALID_INPUT', '最多只能上传 4 张图片。');
  }
  const paths = [];
  for (const image of images) {
    if (typeof image !== 'string' || image.trim() === '') {
      throw new XPosterError('INVALID_INPUT', '每张图片的路径必须是非空字符串。');
    }
    const expanded = expandHome(image);
    if (!isAbsolute(expanded)) {
      throw new XPosterError('INVALID_INPUT', '图片路径必须是绝对路径。', {
        hint: '请使用图片的完整路径，也可以使用 ~/ 开头的路径。',
      });
    }
    const path = resolve(expanded);
    const extension = extname(path).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)) {
      throw new XPosterError('INVALID_INPUT', '图片仅支持 jpg、jpeg、png、webp 和 gif 格式。');
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new XPosterError('INVALID_INPUT', '图片文件不存在或无法读取。', {
        hint: '请检查图片的完整路径和文件权限。',
      });
    }
    if (!info.isFile()) throw new XPosterError('INVALID_INPUT', '图片路径必须指向文件。');
    const maxMB = extension === '.gif' ? 15 : 5;
    if (info.size > maxMB * 1024 * 1024) {
      throw new XPosterError('INVALID_INPUT', `单张${extension === '.gif' ? ' GIF' : '图片'}不能超过 ${maxMB} MB。`);
    }
    paths.push(path);
  }
  return { text, images: paths, weightedLength: weightedLength(text) };
}

export function parseScheduledAt(value, now = new Date()) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/);
  const invalid = () => new XPosterError('INVALID_INPUT', 'scheduled_at 必须是有效的 ISO 8601 日期时间；无偏移量时使用电脑本地时区。');
  if (!match) throw invalid();
  const [, y, m, d, h, min, sec = '0', , offset] = match;
  const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > days
    || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) throw invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid();
  if (!offset && (date.getFullYear() !== Number(y) || date.getMonth() + 1 !== Number(m)
    || date.getDate() !== Number(d) || date.getHours() !== Number(h) || date.getMinutes() !== Number(min))) throw invalid();
  if (date.getTime() - now.getTime() < 5 * 60 * 1000) {
    throw new XPosterError('INVALID_INPUT', '预排期时间必须至少在 5 分钟以后。');
  }
  if (date.getFullYear() > now.getFullYear() + 2) {
    throw new XPosterError('INVALID_INPUT', '预排期年份不能超过当前年份加 2 年。');
  }
  return { date, components: {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(),
  } };
}

export async function validateThreadInput(input, mode = 'preview') {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['posts', 'in_reply_to', 'scheduled_at'].includes(key))) {
    throw new XPosterError('INVALID_INPUT', '串文参数必须是包含 posts 的对象。');
  }
  const reply = input.in_reply_to;
  if (reply !== undefined && (typeof reply !== 'string' || !reply || /\D/.test(reply))) {
    throw new XPosterError('INVALID_INPUT', 'in_reply_to 必须是帖子的纯数字字符串。');
  }
  const hasSchedule = Object.hasOwn(input, 'scheduled_at');
  if (reply !== undefined && hasSchedule) throw new XPosterError('INVALID_INPUT', '接续串文不支持预排期。');
  if (mode === 'post' && hasSchedule) throw new XPosterError('INVALID_INPUT', '带 scheduled_at 的串文请使用 x_thread_schedule。');
  if (mode === 'schedule' && reply !== undefined) throw new XPosterError('INVALID_INPUT', '只能预排期新串文。');
  let scheduled = hasSchedule || mode === 'schedule' ? parseScheduledAt(input.scheduled_at) : null;
  if (scheduled) scheduled = parseScheduledAt(new Date(Math.ceil(scheduled.date.getTime() / 60000) * 60000).toISOString());
  const minimum = reply === undefined ? 2 : 1;
  if (!Array.isArray(input.posts) || input.posts.length < minimum || input.posts.length > 25) {
    throw new XPosterError('INVALID_INPUT', `串文需要 ${minimum} 到 25 条帖子。`);
  }
  const posts = [];
  for (const post of input.posts) {
    if (!post || typeof post !== 'object' || Array.isArray(post)
      || Object.keys(post).some(key => !['text', 'images'].includes(key))) {
      throw new XPosterError('INVALID_INPUT', '每条帖子必须是包含 text 或 images 的对象。');
    }
    posts.push(await validatePostInput(post));
  }
  return { posts, inReplyTo: reply, scheduled };
}
