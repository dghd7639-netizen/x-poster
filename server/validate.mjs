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
