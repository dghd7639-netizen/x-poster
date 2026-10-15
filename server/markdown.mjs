import { resolve, isAbsolute, extname } from 'node:path';
import { validatePostInput } from './validate.mjs';
import { XPosterError } from './errors.mjs';

export const MAX_MARKDOWN_BYTES = 1024 * 1024;
const invalid = message => new XPosterError('INVALID_INPUT', message);
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const safeLink = value => {
  try { return /^https?:$/i.test(new URL(value).protocol); } catch { return false; }
};

// Read balanced destinations so javascript:alert(1) and local filenames with parentheses stay one token.
function linkAt(source, start) {
  const match = source.slice(start).match(/^(!?)\[([^\]\n]*)\]\(/);
  if (!match) return null;
  const from = start + match[0].length;
  let end = from;
  if (source[from] === '<') {
    end = source.indexOf('>', from + 1);
    if (end < 0 || source[end + 1] !== ')') return null;
    return { image: !!match[1], label: match[2], target: source.slice(from + 1, end), end: end + 2 };
  }
  let depth = 1;
  for (; end < source.length; end++) {
    if (source[end] === '\n') return null;
    if (source[end] === '\\') { end++; continue; }
    if (source[end] === '(') depth++;
    if (source[end] === ')' && --depth === 0) break;
  }
  if (depth !== 0) return null;
  return { image: !!match[1], label: match[2], target: source.slice(from, end).trim(), end: end + 1 };
}

function inline(source, warn, depth = 0, links = true) {
  let html = '';
  let text = '';
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i);
    const code = rest.match(/^`+([^`]*?)`+/);
    if (code) { html += escape(code[1]); text += code[1]; i += code[0].length; continue; }
    const link = source[i] === '[' ? linkAt(source, i) : null;
    if (link) {
      const label = inline(link.label, warn, depth + 1, false);
      html += links && safeLink(link.target) ? `<a href="${escape(link.target)}">${label.html}</a>` : label.html;
      text += label.text;
      i = link.end;
      continue;
    }
    const auto = rest.match(/^<(https?:\/\/[^<>\s]+)>/i);
    if (auto) { html += links ? `<a href="${escape(auto[1])}">${escape(auto[1])}</a>` : escape(auto[1]); text += auto[1]; i += auto[0].length; continue; }
    const raw = rest.match(/^<\/?[a-zA-Z][^>]*>|^<!--[\s\S]*?-->/);
    if (raw) { warn('原始 HTML 已按文字处理。'); html += escape(raw[0]); text += raw[0]; i += raw[0].length; continue; }
    let styled = false;
    if (depth < 20) for (const [delimiter, tag] of [['**', 'strong'], ['__', 'strong'], ['~~', 's'], ['*', 'em'], ['_', 'em']]) {
      if (!rest.startsWith(delimiter) || /\s/.test(rest[delimiter.length] ?? ' ')) continue;
      if ((delimiter.length === 1 || delimiter.includes('_')) && /[\p{L}\p{N}_]/u.test(source[i - 1] ?? '')) continue;
      let end = source.indexOf(delimiter, i + delimiter.length);
      if (delimiter.length === 1) {
        while (end >= 0 && (source[end - 1] === delimiter || source[end + 1] === delimiter)) end = source.indexOf(delimiter, end + 1);
      } else if (delimiter !== '~~' && end >= 0 && source[end + 2] === delimiter[0]) {
        const inside = source.slice(i + 2, end);
        const singles = delimiter === '**' ? inside.match(/(?<!\*)\*(?!\*)/g) : inside.match(/(?<!_)_(?!_)/g);
        if (singles?.length % 2 === 1) end++;
      }
      if (end < 0 || /\s/.test(source[end - 1])) continue;
      if ((delimiter.length === 1 || delimiter.includes('_')) && /[\p{L}\p{N}_]/u.test(source[end + delimiter.length] ?? '')) continue;
      const value = inline(source.slice(i + delimiter.length, end), warn, depth + 1, links);
      html += `<${tag}>${value.html}</${tag}>`; text += value.text;
      i = end + delimiter.length; styled = true; break;
    }
    if (styled) continue;
    if (source[i] === '\\' && /[\\`*_[\]{}()#+.!>~-]/.test(source[i + 1] ?? '')) i++;
    html += escape(source[i]); text += source[i]; i++;
  }
  return { html, text };
}

export async function validateArticleImage(path, baseDir, cover = false) {
  if (typeof path !== 'string' || !path.trim()) throw invalid('图片路径必须是非空字符串。');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw invalid(`图片路径编码无效：${path}`); }
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) && !isAbsolute(decoded)) throw invalid(`仅支持本地图片路径：${path}`);
  const absolute = resolve(baseDir, decoded);
  if (cover && !['.jpg', '.jpeg', '.png', '.webp'].includes(extname(absolute).toLowerCase())) {
    throw invalid(`封面仅支持 jpg、jpeg、png、webp：${absolute}`);
  }
  try { return (await validatePostInput({ images: [absolute] })).images[0]; }
  catch (error) {
    if (error instanceof XPosterError) throw invalid(`${error.message} 路径：${absolute}`);
    throw error;
  }
}

export async function parseArticleMarkdown(source, { baseDir, title: overrideTitle, cover: overrideCover } = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_MARKDOWN_BYTES) throw invalid('Markdown 必须是最多 1 MB 的文字。');
  if (typeof baseDir !== 'string' || !isAbsolute(baseDir)) throw invalid('Markdown 基础目录必须是绝对路径。');
  const warnings = [];
  const warn = value => { if (!warnings.includes(value)) warnings.push(value); };
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const metadata = {};
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) throw invalid('Markdown front matter 缺少结束的 ---。');
    for (const line of lines.splice(0, end + 1).slice(1, -1)) {
      const match = line.match(/^(title|cover):\s*(.*?)\s*$/);
      if (match) metadata[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  let headingTitle;
  let imageCount = 0;
  const segments = [];
  let blocks = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  const flushHTML = () => {
    if (blocks.length) segments.push({ type: 'html', html: blocks.map(block => block.html).join(''), text: blocks.map(block => block.text).join('\n') });
    blocks = [];
  };
  const joined = values => {
    let html = '';
    let text = '';
    values.forEach((line, index) => {
      const hard = / {2,}$|\\$/.test(line);
      const value = inline(line.replace(/ {2,}$|\\$/, '').trim(), warn);
      html += value.html; text += value.text;
      if (index < values.length - 1) { html += hard ? '<br>' : ' '; text += hard ? '\n' : ' '; }
    });
    return { html, text };
  };
  const flushParagraph = () => {
    if (paragraph.length) { const value = joined(paragraph); blocks.push({ html: `<p>${value.html}</p>`, text: value.text }); }
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ html: `<${list.tag}>${list.items.map(value => `<li>${value.html}</li>`).join('')}</${list.tag}>`, text: list.items.map(value => value.text).join('\n') });
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) { const value = joined(quote); blocks.push({ html: `<blockquote>${value.html}</blockquote>`, text: value.text }); }
    quote = [];
  };
  const flush = () => { flushParagraph(); flushList(); flushQuote(); };
  const addImage = async token => {
    if (/^https?:\/\//i.test(token.target)) { warn('远程图片已跳过，请先下载到本地再引用。'); return; }
    if (++imageCount > 50) throw invalid('文章最多支持 50 张正文图片。');
    const path = await validateArticleImage(token.target, baseDir);
    flush(); flushHTML();
    const previous = segments.at(-1);
    if (previous?.type === 'images' && previous.paths.length < 4) previous.paths.push(path);
    else segments.push({ type: 'images', paths: [path] });
  };
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenced = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenced && fenced[1][0] === fence[0] && fenced[1].length >= fence.length) fence = null;
      else blocks.push({ html: `<p>${line ? escape(line) : '<br>'}</p>`, text: line });
      continue;
    }
    if (fenced) { flush(); fence = fenced[1]; warn('代码块已作为普通段落粘贴，不保留代码格式。'); continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      heading[2] = heading[2].replace(/\s+#+$/, '');
      flush();
      if (heading[1] === '#' && headingTitle === undefined) { headingTitle = inline(heading[2], warn).text; continue; }
      const value = inline(heading[2], warn);
      const tag = heading[1].length <= 2 ? 'h1' : 'h2';
      blocks.push({ html: `<${tag}>${value.html}</${tag}>`, text: value.text }); continue;
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { flush(); warn('v1 不支持分割线，已跳过。'); continue; }
    if (/^\s*\|.*\||^\s*[^|]+\|/.test(line) && (line.includes('|') && (lines[index + 1]?.match(/^\s*\|?\s*:?-{3,}/) || lines[index - 1]?.includes('|')))) {
      flush(); warn('表格已作为普通段落粘贴，不保留表格布局。');
      blocks.push({ html: `<p>${escape(line)}</p>`, text: line }); continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (item) {
      flushParagraph(); flushQuote();
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
      if (item[1]) warn('嵌套列表已展平为单层列表。');
      list.items.push(inline(item[3], warn)); continue;
    }
    if (/^\s*>/.test(line)) { flushParagraph(); flushList(); quote.push(line.replace(/^\s*>\s?/, '')); continue; }
    flushList(); flushQuote();
    let start = 0;
    for (let pos = 0; pos < line.length;) {
      if (line[pos] === '`') {
        const run = line.slice(pos).match(/^`+/)[0];
        const end = line.indexOf(run, pos + run.length);
        pos = end < 0 ? pos + run.length : end + run.length;
        continue;
      }
      const token = line.startsWith('![', pos) && (pos === 0 || line[pos - 1] !== '\\') ? linkAt(line, pos) : null;
      if (!token) { pos++; continue; }
      if (line.slice(start, pos).trim()) paragraph.push(line.slice(start, pos));
      await addImage(token);
      start = token.end; pos = token.end;
    }
    if (line.slice(start).trim()) paragraph.push(line.slice(start));
  }
  flush(); flushHTML();
  const title = overrideTitle ?? metadata.title ?? headingTitle;
  if (typeof title !== 'string' || !title.trim()) throw invalid('请通过首个 # 标题、front matter title 或 title 参数提供文章标题。');
  if (!segments.some(segment => segment.type === 'images' || segment.text.trim())) throw invalid('文章正文不能为空。');
  const coverPath = overrideCover ?? metadata.cover;
  const cover = coverPath === undefined ? undefined : await validateArticleImage(coverPath, baseDir, true);
  return { title: title.trim(), segments, warnings, ...(cover ? { cover } : {}) };
}
