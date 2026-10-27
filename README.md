# x-poster

让 Claude Code 和 Codex 通过本机 Chrome 在 X（Twitter）发布文字和最多 4 张本地图片。默认流程为**预览 → 用户明确确认 → 发布 → 返回链接**，用户提供的文字保持原样。支持使用 **X 自带的预排期** 定时发帖，由 X 服务器到时发布，电脑可以关机。

插件运行一个零依赖的 Node.js ≥ 22 MCP stdio 服务器，名称为 `x-poster`，启动命令为 `node server/index.mjs`。服务器通过 Chrome DevTools Protocol（CDP）操作专用浏览器 profile，提供推文、串文、预排期和 Markdown 长文章的十六个工具（见工具参考）。仓库根目录同时是两种宿主的插件根目录和市场根目录；两种宿主共用 `skills/x-poster/SKILL.md` 和默认数据目录 `~/.x-poster`，登录一次即可共用会话。

## ⚠️ 风险

[X 的自动化规则](https://help.x.com/en/rules-and-policies/x-automation)禁止通过脚本操作网站等非 API 自动化方式，使用本插件可能导致账号被限制，甚至永久停用。

插件采用预览后确认、默认 60 秒发布间隔、滚动 24 小时最多 20 条，以及默认可见的浏览器窗口来减少误发和过度操作；这些措施无法消除平台规则风险。需要官方支持的程序化发布方式时，请使用 [官方 X API](https://help.x.com/en/rules-and-policies/x-api)，并遵循相应规则。

登录使用不受自动化控制的普通 Chrome；预览和发布仍使用 CDP 控制的 Chrome，`navigator.webdriver` 为 `true`，X 可能将其视为自动化操作。这也是上述风险的一部分。

## 环境要求

- Node.js **≥ 22**，可在启动宿主的环境中运行 `node`。
- Google Chrome，或 Chromium / Microsoft Edge / Brave。默认自动查找，也可指定浏览器路径。
- 本机图形界面，用于用户自行登录和处理验证。

零依赖，无需为运行插件安装第三方 npm 包。

macOS 默认让自动化 Chrome 在当前应用后方运行，不抢焦点。窗口仍存在于其他窗口后面，可点击 Chrome 查看；设置 `X_POSTER_FOREGROUND=1` 可让窗口来到前台。登录窗口仍在前台打开。不推荐无头模式：X 很容易识别它。

## 安装到 Claude Code

从本地仓库安装，将占位符替换为实际绝对路径：

```bash
claude plugin marketplace add "<本仓库路径>"
claude plugin install x-poster@x-poster
```

也可在 Claude Code 会话中使用：

```text
/plugin marketplace add <本仓库路径>
/plugin install x-poster@x-poster
/reload-plugins
```

路径含空格时请用引号包裹。仓库发布到 GitHub 后，可用以下命令添加市场，再运行相同的安装命令：

```bash
claude plugin marketplace add <owner>/<repo>
```

MCP 配置直接内联于 `.claude-plugin/plugin.json`，使用 `${CLAUDE_PLUGIN_ROOT}/server/index.mjs`。技能默认从 `skills/` 加载。**不要创建根目录 `.mcp.json`**：Claude Code 在本仓库内会把它当成项目级配置，而 `${CLAUDE_PLUGIN_ROOT}` 在该上下文中无法解析。

## 安装到 Codex

```bash
codex plugin marketplace add "<本仓库路径>"
codex plugin add x-poster@x-poster
```

仓库发布后，市场来源也可替换为 `<owner>/<repo>`。安装后重启 Codex。

Codex 插件从 `.codex-mcp.json` 加载服务器配置。这里使用 `args: ["server/index.mjs"]` 和 `cwd: "."`，相对工作目录解析到安装后的插件根目录，不依赖 `${...}` 展开。`x_post`、`x_schedule`、`x_thread_post`、`x_thread_schedule`、`x_cancel_scheduled`、`x_article_publish` 和 `x_article_delete` 配置了 `approval_mode: "prompt"`，每次真实发布、创建或取消排期、发布或删除文章都要求宿主向用户请求审批；用户要求跳过预览时仍适用。

不使用插件时，可手动注册 MCP 服务器，并复制共享技能：

```bash
codex mcp add x-poster -- node "<绝对路径>/server/index.mjs"
mkdir -p ~/.codex/skills
cp -R "<本仓库路径>/skills/x-poster" ~/.codex/skills/
```

复制前检查目标是否已有同名技能，避免覆盖。手动注册的配置不自动继承插件的逐次工具审批设置，需保留技能中的预览确认流程；重启 Codex 后使用。

## 可选：Claude Desktop 聊天

在 `claude_desktop_config.json` 的现有配置中合并以下服务器项，替换为实际绝对路径：

```json
{
  "mcpServers": {
    "x-poster": {
      "command": "node",
      "args": ["<绝对路径>/server/index.mjs"]
    }
  }
}
```

保存后重启 Claude Desktop。此方式只注册 MCP 服务器，不自动安装 Claude Code / Codex 的共享技能；聊天中仍应明确要求先预览并等你确认。

## 首次登录

对 agent 说“帮我登录 X”，或在仓库根目录运行：

```bash
node server/cli.mjs login
```

登录窗口是**不受自动化控制的普通 Chrome**，可使用 Google/Apple 账号登录。Google 会拒绝在启用了远程调试端口的浏览器中登录，提示“此浏览器或应用可能不安全”；因此登录窗口不启用远程调试，仍使用相同的专用 profile 和 keychain 参数，以便后续预览和发布共用登录态。

用户在窗口中**自行登录并完成双重认证**。agent 永远不会索要或输入密码。登录完成后，在该 Chrome 中按 **Cmd+Q 完全退出**（Windows/Linux：关闭它的所有窗口），以释放专用 profile 并保存 cookie。CLI `login` 会一直等待，直到该 Chrome 退出后检查并输出登录态；使用 agent 时，退出后告诉它已完成，再由它调用 `x_status` 确认。

MCP `x_login` 的 `wait_seconds` 默认是 `0`，立即返回 `waiting_for_user`（已登录时为 `window_open`）；设为 1–300 时最多等待相应秒数，期间用户完全退出该 Chrome 后检查登录态并返回 `logged_in` 和 `status`，否则返回等待状态，普通窗口继续保持打开。没有登录窗口时限，服务重启也不会主动终止它。已登录时，`x_login` 打开 X 主页，方便用户处理验证提示；完成后同样需要完全退出该 Chrome。窗口仍在运行时，`x_status`、`x_preview`、`x_post`、`x_schedule`、`x_list_scheduled`、`x_cancel_scheduled` 会返回 `LOGIN_IN_PROGRESS` 或 `BROWSER_BUSY`。

Claude Code、Codex 和 Claude Desktop 可以同时安装，默认共用 `~/.x-poster` 的登录态。x-poster 通过跨进程的 `browser.lock` 保证同一数据目录一次只执行一个浏览器任务（包含关闭浏览器）。其他同步调用最多等待 `X_POSTER_BUSY_WAIT_SEC` 秒，默认 15 秒；到期返回 `BUSY`，本次操作没有执行，也不会在之后补执行。如果为不同宿主配置不同的 `X_POSTER_HOME`，它们使用各自目录中的会话。

## 使用方式

可以对 agent 说：

- “帮我预览一条推文：今天天气真好。”
- “把这段话发到 X，先让我确认：今天完成了新项目 🚀”
- “把这张图发到 X，配文保持原样：周末散步。图片是 `/绝对路径/photo.jpg`。”
- “post to X: Hello world! 请先预览。”
- “明天早上 9 点发：今天完成了新项目 🚀，先让我确认。”
- “查看我的预排期帖子。”

agent 先调用 `x_status`，必要时引导用户登录；准备文字和本地图片后调用 `x_preview`，展示最终文字、截图和截图路径，等待你明确确认，再使用**完全相同**的参数调用 `x_post` 并回报链接。修改内容后需重新预览确认。只有本次请求明确要求“直接发布，无需确认”时才跳过预览确认；Codex 插件的工具审批仍须完成。

预排期时，agent 将自然语言时间转换为 ISO 8601（有歧义先询问），用 `scheduled_at` 调用 `x_preview`，展示截图、文字和准确排期时间，得到明确确认后以完全相同的 `text`、`images`、`scheduled_at` 调用 `x_schedule`。不带偏移量的时间使用电脑本地时区；带 `Z` 或 `±hh:mm` 时转换为本地时间。时间至少在 5 分钟后，年份不能超过当前年份加 2。X 的时间控件精确到分钟，输入含非零秒数时向上取整到下一分钟，以预览返回的准确时间为准。排期同样计入本地发布间隔与 24 小时额度。

取消排期时先调用 `x_list_scheduled`，向用户展示待取消帖子的完整文字、准确排期时间和 id，得到明确确认后调用 `x_cancel_scheduled`。工具会核对列表顺序与文字，删除后重新读取列表，确认目标 id 已消失且其他 id 仍在。若文字和时间完全相同导致歧义，则停止并请用户在 X 网页操作。用户也可以随时到 X 网页“未发送的帖子 → 预排期”中取消。遇到 `UNCERTAIN` 绝不重试；若提示其他帖子可能被误删，请立即检查 X。

文字和图片至少需要一项；支持纯文字或纯图片。MCP 图片路径必须为绝对本地路径（支持 `~`），最多 4 张，URL 需先下载。支持 jpg、jpeg、png、webp、gif；图片每张最多 5 MB，GIF 最多 15 MB。CJK 字符和 emoji 按 2 计，链接按 23 计，非 Premium 账号限 280；预览返回加权长度及超限警告，最终是否接受由 X 决定。

## 串文（Threads）

支持三种模式：立即发布新串文、接在自己已有帖子后面、使用 X 原生预排期发布新串文。统一参数为 `posts: [{ text?, images? }, …]`，每条至少有文字或图片，最多 4 张图片，格式及大小与单帖相同。新串文需要 **2–25 条**；提供纯数字字符串 `in_reply_to` 时可接续 **1–25 条**。接续目标只能是当前登录用户自己的帖子，工具会核对回复对象与登录用户名；无法确认身份就停止。`in_reply_to` 不能与 `scheduled_at` 同用。

先调用 `x_thread_preview`，向用户展示**全部截图、每一条的完整文字、图片和加权长度**，排期还要展示准确时间。超过 280 只警告，由 X 最终判断账号是否可发布。用户明确确认后，以**完全相同的参数**调用 `x_thread_post` 或 `x_thread_schedule`；修改任一条内容、目标或时间都应重新预览。接续预览先显示原帖与第一条回复，再在普通发帖框渲染全部内容；第二组截图仅用于预览，实际发布仍逐条回复。截图只截取发帖区域，视口最高 4000 px，只滚动发帖框内部；每次预览最多 8 张，接续时包括 1 张目标图和最多 7 张整串图。覆盖不完整时返回 `warnings`：串文较长，截图只覆盖前面部分，请在 X 中检查。请展示警告并检查完整内容后再确认。

立即新串文使用“全部发帖”，确认所有 ID 后返回有序 `posted_ids`、`urls`、`count` 和首帖 `thread_url`。接续则每一步都回复上一条新帖，`thread_url` 指向原目标；某一步失败就立即停止，后续帖子不再提交。返回 `UNCERTAIN` 时必须展示 `posted_ids`，**不要重试，请用户检查主页上的串文是否完整**。客户端超时也不能当作未发布后重新调用。

排期只支持新串文，`scheduled_at` 必填，时间规则与单帖相同，非零秒数向上取整到下一分钟。提交后核对 `CreateScheduledTweet` 请求中的帖子数量和每条文字；不一致时返回 `UNCERTAIN`，请用户检查排期列表，绝不自动取消。X 把整串显示为**一个排期条目**（列表文字是第一条），返回一个 `id`；先展示并确认这个条目，再用现有 `x_cancel_scheduled({ id })` 即可取消整串，取消不会退还已占用的本地额度。

**每一条帖子都计入额度**：5 条串文消耗 5 条滚动 24 小时额度，即使 X 列表只显示一个排期条目。提交前整串检查剩余额度；不足返回 `RATE_LIMITED`，附 `posts_remaining`、`requested_count` 和等待秒数。默认每天最多 20 条，因此 21–25 条串文在默认额度下不能提交。最小间隔按整次操作计算，不会在一串内部逐条等待 60 秒。历史每串保存一条记录并带 `count`；不确定提交按可能已发出的条数保守计入，附已知 `posted_ids`。

三个 MCP 串文工具均使用**进程内后台任务**，先完成输入校验，再通过 `exclusive` 和跨进程锁等待浏览器，最长排队 15 分钟。每次调用最多等待 `X_POSTER_TOOL_WAIT_SEC`（默认 45 秒）；及时完成时返回最终结果、全部图像及 `job_id`，未完成时返回 `ok: true`、`status: "in_progress"`、`job_id`、`waiting_for_browser`、`elapsed_sec` 和 `next_step`。

拿到 `job_id` 后反复调用只读、幂等的 **`x_job_status({ job_id })`**，直到取得最终结果或原始错误；`x_article_status` 保留为兼容别名，文章和串文任务都可查询。**不要重新调用正在运行任务的创建工具，绝不要为这些帖子再次调用 `x_thread_post` 或 `x_thread_schedule`，否则会创建重复串文。** 预览也应查询已有任务，完成后展示全部截图再请用户确认。`UNCERTAIN` 仍须展示 `posted_ids` 并请用户检查主页或预排期列表，绝不重试。

任务完成后保留 1 小时；进程重启或任务未知、过期后，应先到 X 核对，不能盲目重发。排队到期返回 `BUSY` 的任务不会稍后补执行。CLI 三个串文命令保持同步，始终等待最终结果，不返回 `in_progress` 或 `job_id`。

CLI 用 `--file` 指定 JSON 或 Markdown；图片路径相对于**文件所在目录**解析，支持绝对路径和 `~/`。JSON 是帖子数组：

```json
[
  { "text": "第一条\n第二行", "images": ["./one.png"] },
  { "text": "第二条", "images": ["./two.jpg"] }
]
```

Markdown 用仅含 `---` 的行分隔帖子，每条内的 `![](路径)` 提取为附件，其余内容保留为文字；含空格的图片路径可写 `![](<two image.png>)`：

```markdown
第一条正文
![](one.png)
---
第二条正文
![](two.jpg)
```

```bash
node server/cli.mjs thread-preview --file ./thread.json
# 展示并明确确认全部帖子后：
node server/cli.mjs thread-post --file ./thread.json
# 接续自己的帖子；预览确认后再用相同参数 thread-post：
node server/cli.mjs thread-preview --file ./thread.md --reply-to 123456789
# 将时间替换为至少 5 分钟后；确认后再用相同参数 thread-schedule：
node server/cli.mjs thread-preview --file ./thread.md --at '2027-01-01T09:00+08:00'
node server/cli.mjs thread-schedule --file ./thread.md --at '2027-01-01T09:00+08:00'
```

## 工具参考

共 16 个 MCP 工具。

| 工具 | 参数 | 行为与结果 |
|---|---|---|
| `x_status` | 无 | 返回 `logged_in`、`username`、`login_window_open`、`posts_last_24h`、`last_post_at`、`next_post_allowed_in_sec`、`limits`、`headless`、`data_dir`。 |
| `x_login` | `wait_seconds?`（0–300，默认 0） | 用不受自动化控制的普通 Chrome 打开登录页或主页，支持 Google/Apple 登录，由用户自行操作。完成后按 Cmd+Q 完全退出该 Chrome（Windows/Linux 关闭它的所有窗口）。默认立即返回 `waiting_for_user` 或 `window_open`；1–300 最多等待相应秒数，用户退出后检查并返回登录态，否则继续等待用户操作，窗口无时限。 |
| `x_preview` | `text?`、`images?`、`scheduled_at?` | 填写发帖框，等待图片上传，保存并返回截图图像及路径，丢弃推文而不发布；返回 `weighted_length`，超过 280 时警告；带排期时间时预览排期并返回 `scheduled_at`（带偏移量）及 `scheduled_at_local`。 |
| `x_post` | `text?`、`images?` | 真实发布，返回 `id` 和 `url`。 |
| `x_schedule` | `text?`、`images?`、`scheduled_at`（必填） | 创建 X 原生预排期，返回 `scheduled: true`、`id`、`scheduled_at`、`scheduled_at_local`、`manage_url`。 |
| `x_thread_preview` | `posts`、`in_reply_to?`、`scheduled_at?` | 后台任务；未完成时返回 `in_progress` 和 `job_id`；完成后返回 `job_id`、每条内容／图片／加权长度、数量、所有截图路径及 MCP 图像；接续另含回复对象、目标文字片段；排期另含准确时间。 |
| `x_thread_post` | `posts`、`in_reply_to?` | 发布已预览确认的新串文或逐条接续自己的帖子；未完成时返回 `in_progress` 和 `job_id`；完成后返回 `job_id`、有序 `posted_ids`、`urls`、`count`、`thread_url`。 |
| `x_thread_schedule` | `posts`、`scheduled_at` | 后台原生排期新串文；未完成时返回 `in_progress` 和 `job_id`；完成后返回 `job_id`、`ok`、`scheduled`、一个 `id`、`count`、准确时间及 `manage_url`。取消此 id 即取消整串。 |
| `x_list_scheduled` | 无 | 返回按时间排序的 `scheduled` 和 `count`；每项含 `id`、`scheduled_at`、`text`、`media_count`、`state`（未知时为 `null`）。 |
| `x_cancel_scheduled` | `id`（纯数字字符串） | 取消一个用户已明确确认的预排期帖；成功返回 `deleted: true`、`id` 和剩余数量 `remaining`，取消不计入发布额度。 |
| `x_article_draft` | `markdown_path`（绝对路径）、`title?`、`cover?`（绝对路径） | 从 Markdown 新建文章草稿；长任务返回 `in_progress` 和 `job_id`，完成后返回 `job_id`、`article_id`、`edit_url`、标题、图片实际／预期数量、封面状态、字数文字、截图路径与图像、`warnings` 和 `next_step`；不会修改已有草稿。 |
| `x_job_status` | `job_id`（UUID） | 只读、幂等查询任意文章或串文任务；返回最终结果及全部图像、原始错误或 `in_progress`；完成后保留 1 小时，无需审批。 |
| `x_article_status` | `job_id`（UUID） | `x_job_status` 的兼容别名，行为相同，也支持串文任务。 |
| `x_article_cover` | `article_id`（纯数字字符串）、`cover`（绝对路径，支持 `~`） | 为用户指定的已有草稿添加或替换封面，返回 `article_id`、`edit_url`、`replaced`、`cover: true`、截图路径与图像；不发布、不修改正文、不写历史、不占发布额度。 |
| `x_article_publish` | `article_id`（纯数字字符串） | 发布用户明确确认的这份草稿，返回 `article_id`，能确定链接时返回 `url`；计入发布限制。 |
| `x_article_delete` | `article_id`（纯数字字符串） | 删除用户明确确认的草稿，核验删除响应和列表后返回 `deleted: true`；不计入发布限制。 |

`text` 为字符串，`images` 为本地路径数组。预览截图默认位于 `~/.x-poster/previews/`；预览不计入真实发布额度。

草稿最终结果包含 `text_chars_inserted` 和 `text_chars_expected`，分别表示正文 `[data-text=true]` 元素的实际非空白字数与 Markdown 纯文本预期非空白字数；实际总数低于预期的 90% 时返回 `UNCERTAIN`。

## 文章

X Articles 是 `https://x.com/compose/articles` 的长文章编辑器，需要**具备文章权限的 X Premium 账号**；没有新建入口时返回 `ARTICLES_UNAVAILABLE`。新文章采用 **新建草稿 → 用户审阅截图或 `edit_url` → 明确确认该 `article_id` → 发布**。草稿就是预览，不会公开；只要草稿时到此停止。不要把草稿截图当作发布成功。

多图长文章可能超过客户端约 60 秒的超时。`x_article_draft` 默认等待 45 秒；未完成时返回 `ok: true`、`status: "in_progress"`、`job_id`、`elapsed_sec`、`next_step`，已知草稿 id 时还返回 `article_id` 和 `edit_url`。草稿任务等待浏览器时返回 `waiting_for_browser: true`，最多排队 15 分钟，开始执行后该字段变为 `false`；排队到期以 `BUSY` 结束任务。此时反复调用 `x_job_status({ job_id })`，直到得到最终结果及图像或错误。**任务进行中或收到 `UNCERTAIN` 后，绝不要为同一个文件再次调用 `x_article_draft`，否则会创建重复草稿。**

任务存储在当前服务器进程内，完成后保留 1 小时，后续工具调用时清理。任务未知或过期时先检查 https://x.com/compose/articles，不要盲目重建。客户端取消请求不会取消草稿工作；stdin 关闭或收到 SIGTERM / SIGINT 时，服务器默认等待正在执行或排队的工作最多 180 秒；第二次 SIGINT 立即退出。退出宽限到期或进程重启后不能继续轮询旧任务，需到 X 核对草稿。CLI 的 `article-draft` 始终等待最终结果，不输出 `in_progress`。

提供本地 `.md` 文件，最多 1 MB，正文不能为空，正文图片最多 50 张。标题优先级是工具／CLI 参数 `title` → front matter `title:` → 首个 `# ` 标题；首个 `# ` 标题会从正文移除。可选 front matter 使用简单的 `key: value`（支持成对引号），不支持完整 YAML：

```markdown
---
title: 我的长文章
cover: ./images/封面.webp
---
# 这个标题会从正文移除

## 章节标题
### 小节副标题

正文支持 **粗体**、*斜体* 和 [链接](https://example.com)。

![配图](<images/图片 1.png>)
```

| Markdown | 文章格式 |
|---|---|
| `##` | 标题（粘贴为 `<h1>`） |
| `###`–`######` | 副标题（`<h2>`） |
| 普通段落 | `<p>`；连续行以空格连接；行尾两个空格或反斜杠保留换行（`<br>`） |
| `-`、`*`、`+` / `1.` 列表 | 无序／有序列表；嵌套展平并警告 |
| `>` | 引用 |
| `**粗体**`、`__粗体__` / `*斜体*`、`_斜体_` / `~~删除线~~` | 粗体／斜体／删除线；斜体按词边界识别 |
| `[文字](https://…)`、`<https://…>` | HTTP(S) 链接；其他协议只保留文字 |
| 行内反引号代码 | 保留代码文字 |
| 独立图片行或段落中的图片 | 在对应位置插入本地图片，连续图片每组最多 4 张 |

图片仅使用本地文件，路径相对于 `.md` 所在目录，也支持绝对路径、`%20` 和 `<带空格的路径>`。jpg、jpeg、png、webp 每张最多 5 MB，gif 最多 15 MB。远程 HTTP(S) 图片会跳过并警告，请先自行下载到本地。文件缺失会在启动浏览器前报错并给出路径。

`---` / `***` 分割线会跳过，围栏代码块和表格降级为普通段落，原始 HTML 按文字转义；这些情况会返回 `warnings`。请在发布前核对警告与排版。封面可用 front matter `cover:`（相对 `.md` 目录），或参数 `cover`（MCP 为绝对路径、CLI 可相对路径）覆盖；封面支持 jpg、jpeg、png、webp，最多 5 MB。

更改内容时可以在 X 打开 `edit_url` 手动编辑，或明确确认后用 `x_article_delete` 删除刚创建的草稿，再从修改后的 Markdown 新建。只删除本会话创建的草稿，或用户明确提供 id 并确认的草稿；绝不自动改动其他草稿。创建和删除草稿不占发布额度；文章发布与推文共用额度，删除不会退还发布额度。遇到 `UNCERTAIN` 不要重试，请检查 `edit_url` 和文章列表的“草稿／已发布”标签。

### 为已有草稿添加或替换封面

`x_article_cover`、`x_article_publish` 和 `x_article_delete` 仅适用于草稿。

使用 `x_article_cover({ article_id: "123", cover: "/绝对路径/cover.png" })`，目标必须是用户指定的草稿；不必为了换封面重建草稿。MCP 路径须为绝对路径（支持 `~/`），CLI 可使用相对路径：

```bash
node server/cli.mjs article-cover --id '123' --cover ./cover.png
```

封面推荐 **5:2** 比例，支持 **jpg（含 jpeg）、png、webp**，最多 5 MB，不支持 GIF。X 会弹出裁剪对话框，x-poster 点击“应用”使用默认裁剪。工具等待媒体处理完成及本次 `ArticleEntityUpdateCoverMedia` 的 HTTP 200 成功响应，再核验封面并截图；成功响应也必须没有 GraphQL 错误。请向用户展示返回的截图及 `edit_url`，`replaced` 表示此前是否已有封面。此操作不发布、不修改正文、不写入历史，也不占发布额度，无需 Codex 发布审批。

60 秒内没有封面保存响应，或响应含 GraphQL 错误时返回 `UNCERTAIN`，附 `article_id` 和 `edit_url`；请用户检查草稿，不要自动重试。裁剪未完成或媒体处理超时返回 `UPLOAD_FAILED`。

## 配置

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `X_POSTER_HOME` | `~/.x-poster` | 数据目录，包含专用 profile、历史、状态及保留 7 天的预览。 |
| `X_POSTER_CHROME_PATH` | 自动检测 | 浏览器可执行文件路径；自动检测依次尝试 Chrome、Chromium、Edge、Brave。 |
| `X_POSTER_HEADLESS` | `0` | 设为 `1` 后发布使用无窗口模式；X 很容易识别，不推荐使用。登录始终显示窗口。 |
| `X_POSTER_FOREGROUND` | `0` | 设为 `1`（也支持 `true`、`yes`、`on`）后直接启动 Chrome，让窗口来到前台；macOS 默认在后台运行。 |
| `X_POSTER_MIN_INTERVAL_SEC` | `60` | 两次发布之间的最小秒数；`0` 关闭此限制。 |
| `X_POSTER_DAILY_LIMIT` | `20` | 滚动 24 小时的最大发布数量；`0` 关闭此限制。 |
| `X_POSTER_BUSY_WAIT_SEC` | `15` | 同步 MCP 调用等待浏览器空闲的最长秒数，限制在 1–120；无效值回退默认。包括进程内排队及跨进程文件锁等待；到期返回 `BUSY`，不会执行。后台文章及串文任务最多等 15 分钟，CLI 最多等 10 分钟。 |
| `X_POSTER_TOOL_WAIT_SEC` | `45` | MCP 草稿创建、串文预览／发布／排期及任务状态查询单次等待秒数，限制在 5–300；无效值回退默认。应小于客户端工具超时。CLI 始终等待完成。 |
| `X_POSTER_SHUTDOWN_GRACE_SEC` | `180` | stdin 关闭或 SIGTERM / SIGINT 后等待工作完成的最长秒数；`0` 立即退出。 |

Claude Code 可通过启动 shell 设置变量，或合并到 `~/.claude/settings.json` 的 `env` 块：

```json
{
  "env": {
    "X_POSTER_HEADLESS": "0",
    "X_POSTER_MIN_INTERVAL_SEC": "60",
    "X_POSTER_DAILY_LIMIT": "20"
  }
}
```

Codex 在启动它的 shell 中设置变量；当前插件的 `env_vars` 放行原有 5 个变量（HOME、CHROME_PATH、HEADLESS、MIN_INTERVAL_SEC、DAILY_LIMIT）。新增前台／等待／退出变量需由宿主传入 MCP 进程；本次未修改 `.codex-mcp.json`。直接启动服务器或 CLI 时可通过 shell 设置。例如：

```bash
export X_POSTER_HEADLESS=0
export X_POSTER_MIN_INTERVAL_SEC=60
export X_POSTER_DAILY_LIMIT=20
codex
```

修改后重启宿主或 MCP 服务器使配置生效。

## CLI 使用

Markdown 串文会忽略首尾空白分段和文件开头由 `---` 包围、内部非空行均为 `key: value` 的 front matter，代码围栏内的 `---` 不会分割帖子。

CLI 等待浏览器空闲的期限为 10 分钟，等待时只向 stderr 提示一次；到期返回 `BUSY`，本次操作未执行。开始执行后仍等待最终结果。

在仓库根目录运行 `node server/cli.mjs <command>`：

| 命令 | 用途 |
|---|---|
| `status` | 查看登录态和发布统计。 |
| `login` | 打开普通 Chrome 供用户自行登录，等待该 Chrome 完全退出后确认登录态。 |
| `open` | 打开普通 Chrome 供用户登录或处理验证，等待该 Chrome 完全退出后检查登录态。 |
| `preview --text "…" [--image <path> …] [--at <ISO>]` | 预览，不发布；`--image` 可重复。 |
| `post --text "…" [--image <path> …]` | 真实发布；`--image` 可重复。 |
| `schedule --text "…" [--image <path> …] --at <ISO>` | 创建用户已预览确认的预排期；无偏移量时使用电脑本地时区。 |
| `thread-preview --file <json或md> [--reply-to <id>] [--at <ISO>]` | 预览全部帖子；接续不能与排期同用。 |
| `thread-post --file <json或md> [--reply-to <id>]` | 发布已预览确认的新串文或接续自己的帖子。 |
| `thread-schedule --file <json或md> --at <ISO>` | 原生排期已预览确认的新串文。 |
| `scheduled` | 列出预排期帖子。 |
| `cancel --id <id>` | 取消一个预排期帖；先列出并向用户确认准确文字和时间。 |
| `article-draft --file <md> [--title "…"] [--cover <img>]` | 新建文章草稿并截图；文件和封面允许相对路径。 |
| `article-cover --id <id> --cover <image>` | 为已有草稿添加或替换封面并截图；封面允许相对路径，不发布。 |
| `article-publish --id <id>` | 审阅截图或 `edit_url` 并明确确认后，发布这个文章草稿。 |
| `article-delete --id <id>` | 明确确认后删除指定草稿。 |

```bash
node server/cli.mjs status
node server/cli.mjs login
node server/cli.mjs open
node server/cli.mjs preview --text '测试\n第二行 🚀' --image ./photo.jpg
# 核对预览后，由用户决定是否执行以下真实发布命令：
node server/cli.mjs post --text '测试\n第二行 🚀' --image ./photo.jpg
# 将日期替换为至少 5 分钟后的时间；先预览确认，再创建排期：
node server/cli.mjs preview --text '明天见' --at '2026-10-16T09:00'
node server/cli.mjs schedule --text '明天见' --at '2026-10-16T09:00'
node server/cli.mjs scheduled
# 用户确认列表中的准确文字与时间后，将 <id> 替换为目标排期 id：
node server/cli.mjs cancel --id '<id>'
# 文章先创建草稿；核对返回的警告、截图或 edit_url 后再发布：
node server/cli.mjs article-draft --file ./article.md --cover ./cover.png
node server/cli.mjs article-publish --id '<article_id>'
# 用户确认要删除这个草稿时：
node server/cli.mjs article-delete --id '<article_id>'
```

CLI 会把 `--text` 中字面的 `\n` 转为换行，并允许相对图片路径；多图重复 `--image`。纯图片可省略 `--text`。CLI `post`、`schedule`、`thread-post`、`thread-schedule`、`cancel`、`article-publish`、`article-delete` 直接执行指定操作，没有 agent 的预览确认对话或 Codex 的工具审批，请在执行前核对内容和 id。新文章发布前必须先新建草稿并由用户确认；已有草稿可直接使用 `article-cover` 更换封面。

## 数据与安全

默认数据目录为 `~/.x-poster`，可由 `X_POSTER_HOME` 更改：

| 路径 | 内容 |
|---|---|
| `chrome-profile/` | 专用 Chrome profile，包含敏感的 X 登录态。 |
| `history.jsonl` | 推文／文章发布、排期、取消和文章删除历史；取消／删除记录不计入发布限制。 |
| `state.json` | 本地状态。 |
| `previews/` | 预览截图，保留 7 天。 |

macOS 启动 Chrome 时使用 `--use-mock-keychain`，profile 中的 cookie 因此实际上没有有效的加密保护。请把整个数据目录当作敏感数据，勿提交到仓库、公开分享或发送给 agent。插件从不保存密码，但持有登录态的文件仍可用于访问账号。

关闭占用该 profile 的 Chrome 后，执行以下命令可删除专用登录态并退出登录；这会删除该 profile 的全部浏览器数据，下次使用需重新登录：

```bash
rm -rf ~/.x-poster/chrome-profile
```

如使用了自定义 `X_POSTER_HOME`，请删除该目录下对应的 `chrome-profile/`。

## 故障排查

| 错误或现象 | 处理方式 |
|---|---|
| `INVALID_INPUT` | 核对文字、图片绝对路径、数量、格式、大小、排期时间和取消 id；目标不存在或同文同时间有歧义时停止取消；CLI 可使用相对路径。 |
| `ARTICLES_UNAVAILABLE` | 当前账号没有文章新建入口；需要符合资格、具备文章权限的 X Premium 账号。 |
| Google 提示“此浏览器或应用可能不安全” | Google 拒绝在启用了远程调试端口的浏览器中登录。按 Cmd+Q 完全退出占用专用 profile 的 Chrome（Windows/Linux 关闭它的所有窗口），再调用 `x_login` 使用普通登录窗口。 |
| `NOT_LOGGED_IN` / 登录过期 | 调用 `x_login`，由用户重新登录并完全退出该 Chrome，再用 `x_status` 检查。 |
| `BUSY` | **本次操作未执行，也不会稍后执行，可以稍后安全重试。** 如果有文章或串文任务正在进行，先用 `x_job_status` 等它完成。`BUSY` 是唯一明确保证可安全重试的错误；`UNCERTAIN` 表示操作可能已经发生，绝不重试。 |
| `LOGIN_IN_PROGRESS` / `BROWSER_BUSY` | 请用户完成已有登录或检查操作，在该 Chrome 中按 Cmd+Q 完全退出（Windows/Linux 关闭它的所有窗口），再调用 `x_status`。仅关闭标签页可能仍占用专用 profile。 |
| `ACCOUNT_CHALLENGE` | 调用 `x_login`，由用户在普通窗口中自行完成验证，然后完全退出该 Chrome；不要绕过 CAPTCHA。 |
| `RATE_LIMITED` | 按 `retry_after_sec` 等待，不循环尝试。 |
| `BROWSER_NOT_FOUND` | 安装支持的浏览器，或设置 `X_POSTER_CHROME_PATH`。 |
| `BROWSER_LAUNCH_FAILED` | 检查浏览器路径与本机启动环境。 |
| `NETWORK_ERROR` | 检查网络连接；发布阶段失败时先核对主页，避免重复发送。 |
| `UPLOAD_FAILED` | 检查图片与连接，重新预览验证上传。 |
| `TEXT_REJECTED` | X 未接受文字，通常是过长；核对加权长度，修改后重新预览确认。 |
| `POST_REJECTED` | 阅读 X 返回的原因，例如重复内容或疑似自动化；停止，交由用户处理。 |
| `UI_CHANGED` | X 页面改版，需要更新 `server/x.mjs` 的 `SELECTORS` 或 `server/article.mjs` 的 `ARTICLE_SELECTORS`。 |
| `UNCERTAIN` | 无法确认是否已发出；**不要重试或重发**，请用户检查自己的主页；预排期创建或取消则检查“未发送的帖子 → 预排期”；若其他 id 消失，立即核查可能被误删的帖子。文章则检查返回的 `edit_url` 和 `https://x.com/compose/articles` 的“草稿／已发布”标签，自动保存超时的草稿可能不完整。 |
| `INTERNAL_ERROR` | 停止操作，检查本地错误信息；不要公开敏感登录数据。 |
| GUI 宿主提示找不到 `node` | 确保宿主的 `PATH` 含 Node，或把 MCP 配置的 `command` 改为 Node 的绝对路径。 |

单帖、预排期和串文发帖流程出现 `UI_CHANGED` 时，错误 JSON 的 `diagnostics` 字段会尽力记录页面路径（仅 pathname）、视口尺寸、加载状态、对话框与编辑器是否存在。`testids` 仅统计编辑器根节点内部、脱敏后最多 60 种 testid；`page_testids` 单独记录整页固定 12 项安全白名单中实际出现的 testid 及计数，便于编辑器缺失时排查。`composer_buttons` 仅包含编辑器区域内最多 30 个按钮的脱敏 testid、短标签（最多 24 字符）和禁用状态。采集总计最多约 4 秒；失败时可能只有部分信息或为 `null`，不会改变原错误。

结构化诊断不读取 Cookie、本地存储、整页文本或帖子正文，不保留 URL 的查询参数与片段，也不收集编辑器区域之外的按钮标签。testid 中的头像账号后缀、开头数字 id 和连续 6 位以上数字会替换为 `*`，合并计数；按钮标签含 `@`、疑似用户名（已知发帖操作除外）或关联身份 testid 时直接省略。

截图裁剪到编辑器根节点四周各扩展 12 px、且不超出视口的区域，仅保存到本地预览目录中的 `*-diagnostic.png`（权限 `600`）。找不到编辑器根节点时回退到整个视口，会显示背后的页面，请勿公开分享；已有根节点但无法测量时省略截图。绝对路径位于 `diagnostics.screenshot`，图片不会嵌入错误 JSON；截图失败则省略路径。排查时请将 `diagnostics` JSON 和对应截图发给维护者，发送前检查截图中的私人信息。

## 开发

```bash
npm test
claude plugin validate .
```

测试使用 Node.js 内置测试运行器。自动测试不能代替本机 Chrome 登录、预览或真实发布验收；真实发布需有用户对具体内容的授权。

```text
.
├── .claude-plugin/
│   ├── plugin.json             Claude Code 清单，内联 MCP
│   └── marketplace.json        Claude Code 市场
├── .codex-plugin/plugin.json   Codex 清单
├── .codex-mcp.json             Codex MCP 配置，逐次审批真实发布、排期和删除
├── .agents/plugins/marketplace.json  Codex 市场
├── skills/x-poster/SKILL.md     两种宿主共享的使用流程
├── server/
│   ├── index.mjs               MCP stdio 入口
│   ├── tools.mjs               工具定义与处理
│   ├── chrome.mjs              浏览器启动与 CDP
│   ├── lock.mjs                跨进程浏览器任务锁及过期回收
│   ├── x.mjs                   X 页面操作与 SELECTORS
│   ├── thread.mjs              串文填充、截图、响应映射、接续及 CLI 文件解析
│   ├── article.mjs             长文章草稿、发布、删除与 ARTICLE_SELECTORS
│   ├── markdown.mjs            零依赖 Markdown 解析及本地图片校验
│   ├── validate.mjs            输入校验与加权长度
│   ├── limits.mjs              发布历史与频率限制
│   ├── config.mjs              环境变量与路径
│   └── cli.mjs                 人工操作与调试入口
├── test/                       自动测试
├── package.json
├── .gitignore
└── README.md
```
