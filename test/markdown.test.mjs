import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArticleMarkdown } from '../server/markdown.mjs';

async function fixture(t) {
  const baseDir = await mkdtemp(join(tmpdir(), 'x-poster-markdown-'));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  for (const name of ['one.png', 'with space.jpg', 'cover.webp']) await writeFile(join(baseDir, name), 'image');
  return { baseDir };
}

test('extracts first title, front matter and argument precedence without leaking metadata into body', async t => {
  const options = await fixture(t);
  const result = await parseArticleMarkdown('---\ntitle: "元数据标题"\ncover: cover.webp\n---\n# 正文标题\n\n正文', options);
  assert.equal(result.title, '元数据标题');
  assert.equal(result.cover, join(options.baseDir, 'cover.webp'));
  assert.deepEqual(result.segments, [{ type: 'html', html: '<p>正文</p>', text: '正文' }]);
  assert.equal((await parseArticleMarkdown('# 标题\n正文', options)).title, '标题');
  assert.equal((await parseArticleMarkdown('只有正文', { ...options, title: '参数标题' })).title, '参数标题');
  assert.equal((await parseArticleMarkdown('---\ntitle: 元数据\n---\n# 一级标题\n正文', { ...options, title: '参数' })).title, '参数');
});

test('maps headings, paragraphs, hard breaks, lists and blockquotes', async t => {
  const options = await fixture(t);
  const source = '# 标题\n## 标题一\n### 副标题\n###### 深标题\n\n第一行\n第二行  \n第三行\\\n第四行\n\n- 项一\n  + 项二\n* 项三\n\n1. 有序一\n2. 有序二\n\n> 引用一\n> 引用二';
  const { segments, warnings } = await parseArticleMarkdown(source, options);
  assert.equal(segments[0].html, '<h1>标题一</h1><h2>副标题</h2><h2>深标题</h2><p>第一行 第二行<br>第三行<br>第四行</p><ul><li>项一</li><li>项二</li><li>项三</li></ul><ol><li>有序一</li><li>有序二</li></ol><blockquote>引用一 引用二</blockquote>');
  assert.match(segments[0].text, /第一行 第二行\n第三行\n第四行/);
  assert.ok(warnings.some(warning => /嵌套/.test(warning)));
});

test('inline formatting escapes HTML, preserves code as text and allows only safe HTTP links', async t => {
  const options = await fixture(t);
  const { segments, warnings } = await parseArticleMarkdown('# T\n**粗体** __粗__ *斜* _斜_ foo_bar_baz ~~删除~~ `x < y` [链接](https://example.com/a?x=1&y=2) <https://example.com> [坏](javascript:alert(1)) <script>bad</script> & "', options);
  assert.equal(segments[0].html, '<p><strong>粗体</strong> <strong>粗</strong> <em>斜</em> <em>斜</em> foo_bar_baz <s>删除</s> x &lt; y <a href="https://example.com/a?x=1&amp;y=2">链接</a> <a href="https://example.com">https://example.com</a> 坏 &lt;script&gt;bad&lt;/script&gt; &amp; &quot;</p>');
  assert.equal(segments[0].text.includes('javascript:'), false);
  assert.ok(warnings.some(warning => /HTML/.test(warning)));
});

test('groups images at most four, resolves escaped spaces and extracts inline images in order', async t => {
  const options = await fixture(t);
  const source = '# T\nBefore ![a](one.png) after\n\n' + Array(5).fill('![b](<with space.jpg>)').join('\n') + '\n\n![c](with%20space.jpg)\nEnd';
  const { segments } = await parseArticleMarkdown(source, options);
  assert.deepEqual(segments.map(segment => segment.type), ['html', 'images', 'html', 'images', 'images', 'html']);
  assert.equal(segments[1].paths[0], join(options.baseDir, 'one.png'));
  assert.equal(segments[0].text, 'Before');
  assert.equal(segments[2].text, 'after');
  assert.equal(segments[3].paths.length, 4);
  assert.equal(segments[4].paths.length, 2);
  assert.ok(segments[4].paths.every(path => path === join(options.baseDir, 'with space.jpg')));
});

test('remote images are dropped with a download warning, missing images name the path', async t => {
  const options = await fixture(t);
  const result = await parseArticleMarkdown('# T\n正文\n![a](https://example.com/a.png)', options);
  assert.equal(result.segments.length, 1);
  assert.ok(result.warnings.some(warning => /下载.*本地/.test(warning)));
  await assert.rejects(parseArticleMarkdown('# T\n![a](missing.png)', options), error => error.code === 'INVALID_INPUT' && error.message.includes(join(options.baseDir, 'missing.png')));
});

test('code, tables and dividers degrade with explicit warnings and escaped text', async t => {
  const options = await fixture(t);
  const { segments, warnings } = await parseArticleMarkdown('# T\n```js\n# not title\n**plain** <tag>\n\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n***', options);
  assert.equal(segments[0].html, '<p># not title</p><p>**plain** &lt;tag&gt;</p><p><br></p><p>| A | B |</p><p>| --- | --- |</p><p>| 1 | 2 |</p>');
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some(warning => /代码/.test(warning)));
  assert.ok(warnings.some(warning => /表格/.test(warning)));
  assert.ok(warnings.some(warning => /分割线/.test(warning)));
});

test('rejects missing title, empty bodies, excessive bytes/images and invalid local images', async t => {
  const options = await fixture(t);
  for (const source of ['正文', '# T', '# T\n---', '# T\n![r](https://example.com/a.png)', '# T\n' + '中'.repeat(350000), '# T\n' + Array(51).fill('![a](one.png)').join('\n')]) {
    await assert.rejects(parseArticleMarkdown(source, options), error => error.code === 'INVALID_INPUT');
  }
  const large = join(options.baseDir, 'large.png');
  await writeFile(large, '');
  await truncate(large, 5 * 1024 * 1024 + 1);
  for (const path of ['large.png', 'bad.svg', 'file:///tmp/a.png', '%ZZ.png']) {
    await assert.rejects(parseArticleMarkdown(`# T\n![a](${path})`, options), error => error.code === 'INVALID_INPUT');
  }
  assert.equal((await parseArticleMarkdown('# T\n' + Array(50).fill('![a](one.png)').join('\n'), options)).segments.reduce((n, segment) => n + (segment.paths?.length ?? 0), 0), 50);
});

test('plain fallback and HTML preserve nested emphasis, avoid intraword emphasis and do not nest links', async t => {
  const options = await fixture(t);
  const { segments } = await parseArticleMarkdown('# T\n***both*** **bold and *em*** pre*mid*post __bold and _em___ [<https://nested.test>](https://outer.test)', options);
  assert.equal(segments[0].html, '<p><strong><em>both</em></strong> <strong>bold and <em>em</em></strong> pre*mid*post <strong>bold and <em>em</em></strong> <a href="https://outer.test">https://nested.test</a></p>');
});

test('images in code spans and escaped image syntax stay text; title with trailing hash is preserved', async t => {
  const options = await fixture(t);
  const result = await parseArticleMarkdown('# C#\n`![code](missing.png)` \\![escaped](missing.png)', options);
  assert.equal(result.title, 'C#');
  assert.equal(result.segments.length, 1);
  assert.match(result.segments[0].html, /!\[code\]\(missing.png\)/);
});
