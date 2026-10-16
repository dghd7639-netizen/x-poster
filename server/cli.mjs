#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { expandHome } from './config.mjs';
import { XPosterError } from './errors.mjs';
import { setBrowserWaitOptions, status, preview, post, schedule, listScheduled, cancelScheduled, openUserWindow, articleDraft, articleCover, articlePublish, articleDelete } from './tools.mjs';

const usage = `x-poster 命令行（需要 Node.js 22 或更高版本）

用法：node server/cli.mjs <命令> [选项]

命令：
  status   查看登录状态和发布限制
  login    打开普通 Chrome 供用户自行登录，等待用户完全退出该 Chrome
  open     打开普通 Chrome 登录或检查账号，等待用户完全退出该 Chrome
  preview  填写并截图预览，不发布
  post     发布已经由用户确认的文字和图片
  schedule 创建已经由用户预览确认的 X 原生预排期
  scheduled 查看预排期帖子列表
  cancel   按 id 取消已经由用户确认的一个预排期帖子
  article-draft   从 Markdown 新建 X 文章草稿并截图，需符合资格的 Premium 账号
  article-cover   为已有文章草稿添加或替换封面，不发布
  article-publish 发布用户已经审阅并明确确认的文章草稿
  article-delete  删除用户已经明确确认的文章草稿

选项：
  --text <文字>     文字中的字面量 \\n 会转换为换行
  --image <路径>    可重复使用，最多 4 张；支持绝对路径、相对路径和 ~
  --at <ISO>       预排期时间；无偏移量时使用电脑本地时区，至少 5 分钟后
  --id <数字>      cancel 的排期 id 或 article-cover / article-publish / article-delete 的文章 id
  --file <路径>    article-draft 的 .md 文件，最多 1 MB；支持相对路径
  --title <标题>   article-draft 的可选标题，覆盖 Markdown 标题
  --cover <路径>   article-cover 的本地封面，或 article-draft 的可选封面；支持相对路径
  -h, --help        显示帮助

先预览，再请用户确认，最后用完全相同的内容发布。
登录可使用 Google/Apple 账号；完成后按 Cmd+Q 完全退出该 Chrome（Windows/Linux 关闭它的所有窗口）。
请勿索要或代填密码；遇到 UNCERTAIN 不要重试，请用户检查主页或预排期列表。
新文章先 article-draft，展示截图、警告和 edit_url；用户确认这个 id 后才 article-publish。
已有草稿用 article-cover --id <id> --cover <图片> 添加或替换封面，并展示返回截图。
article-delete 仅删除本次创建或用户明确提供 id 并确认的草稿；文章不确定结果检查 x.com/compose/articles。
`;

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main() {
  if (globalThis.WebSocket === undefined) {
    throw new XPosterError('INVALID_INPUT', 'x-poster 需要 Node.js 22 或更高版本');
  }
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        id: { type: 'string' }, at: { type: 'string' }, text: { type: 'string' }, image: { type: 'string', multiple: true },
        file: { type: 'string' }, title: { type: 'string' }, cover: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch { throw new XPosterError('INVALID_INPUT', '命令行参数无效。', { hint: '使用 --help 查看用法。' }); }
  if (values.help || positionals.length === 0) {
    process.stdout.write(usage);
    return 0;
  }
  if (positionals.length !== 1) throw new XPosterError('INVALID_INPUT', '请只指定一个命令。');
  const [command] = positionals;
  if (values.at !== undefined && !['preview', 'schedule'].includes(command)) {
    throw new XPosterError('INVALID_INPUT', '--at 仅用于 preview 或 schedule。');
  }
  if (values.id !== undefined && !['cancel', 'article-cover', 'article-publish', 'article-delete'].includes(command)) {
    throw new XPosterError('INVALID_INPUT', '--id 仅用于 cancel、article-cover、article-publish 或 article-delete。');
  }
  if (['file', 'title'].some(key => values[key] !== undefined) && command !== 'article-draft') {
    throw new XPosterError('INVALID_INPUT', '--file 和 --title 仅用于 article-draft。');
  }
  if (values.cover !== undefined && !['article-draft', 'article-cover'].includes(command)) {
    throw new XPosterError('INVALID_INPUT', '--cover 仅用于 article-draft 或 article-cover。');
  }
  if (command.startsWith('article-') && (values.text !== undefined || values.image !== undefined)) {
    throw new XPosterError('INVALID_INPUT', '文章命令请使用 --file 或 --id，不接受 --text / --image。');
  }
  const input = {
    text: values.text?.replace(/\\n/g, '\n'),
    ...(values.at !== undefined ? { scheduled_at: values.at } : {}),
    images: (values.image ?? []).map(path => resolve(expandHome(path))),
  };
  let waitingPrinted = false;
  setBrowserWaitOptions({ maxWaitMs: 10 * 60 * 1000, onWait: () => {
    if (waitingPrinted) return;
    waitingPrinted = true;
    console.error('x-poster 正在执行另一个浏览器任务，正在等待空闲（最多 10 分钟）；本次操作尚未执行。');
  } });
  switch (command) {
    case 'status': print((await status()).data); return 0;
    case 'login': {
      const current = (await status()).data;
      if (current.logged_in) { print({ ...current, message: '当前已登录 X。' }); return 0; }
      const { done } = await openUserWindow();
      console.error('已打开普通 Chrome 窗口。请在窗口中自行登录 X（可使用 Google/Apple 账号，包括两步验证）。登录完成后按 Cmd+Q 完全退出该 Chrome（Windows/Linux 关闭它的所有窗口），本命令会自动确认登录状态。');
      const outcome = await done;
      print(outcome);
      return outcome.logged_in ? 0 : 1;
    }
    case 'open': {
      const { done } = await openUserWindow();
      console.error('已打开普通 Chrome 窗口。请在窗口中自行登录 X 或处理验证提示（可使用 Google/Apple 账号）。完成后按 Cmd+Q 完全退出该 Chrome（Windows/Linux 关闭它的所有窗口），本命令会自动确认登录状态。');
      print(await done);
      return 0;
    }
    case 'preview': print((await preview(input)).data); return 0;
    case 'schedule': print((await schedule(input)).data); return 0;
    case 'cancel': print((await cancelScheduled({ id: values.id })).data); return 0;
    case 'scheduled': print((await listScheduled()).data); return 0;
    case 'post': print((await post(input)).data); return 0;
    case 'article-draft': print((await articleDraft({
      markdown_path: values.file === undefined ? undefined : resolve(expandHome(values.file)),
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.cover !== undefined ? { cover: resolve(expandHome(values.cover)) } : {}),
    })).data); return 0;
    case 'article-cover': print((await articleCover({ article_id: values.id,
      cover: values.cover === undefined ? undefined : resolve(expandHome(values.cover)),
    })).data); return 0;
    case 'article-publish': print((await articlePublish({ article_id: values.id })).data); return 0;
    case 'article-delete': print((await articleDelete({ article_id: values.id })).data); return 0;
    default: throw new XPosterError('INVALID_INPUT', '未知命令。', { hint: '使用 --help 查看用法。' });
  }
}

try { process.exit(await main()); }
catch (error) {
  if (!(error instanceof XPosterError)) console.error('x-poster 内部错误：', error);
  const reported = error instanceof XPosterError ? error : new XPosterError('INTERNAL_ERROR', '发生内部错误。');
  process.stderr.write(`${JSON.stringify({ ok: false, ...reported.toJSON() }, null, 2)}\n`);
  process.exit(1);
}
