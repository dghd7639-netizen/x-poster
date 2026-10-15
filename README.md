# x-poster

让 Claude Code 和 Codex 通过本机 Chrome 在 X（Twitter）发布文字和最多 4 张本地图片。默认流程为**预览 → 用户明确确认 → 发布 → 返回链接**，用户提供的文字保持原样。支持使用 **X 自带的预排期** 定时发帖，由 X 服务器到时发布，电脑可以关机。

插件运行一个零依赖的 Node.js ≥ 22 MCP stdio 服务器，名称为 `x-poster`，启动命令为 `node server/index.mjs`。服务器通过 Chrome DevTools Protocol（CDP）操作专用浏览器 profile，提供 `x_status`、`x_login`、`x_preview`、`x_post`、`x_schedule`、`x_list_scheduled`、`x_cancel_scheduled` 七个工具。仓库根目录同时是两种宿主的插件根目录和市场根目录；两种宿主共用 `skills/x-poster/SKILL.md` 和默认数据目录 `~/.x-poster`，登录一次即可共用会话。

## ⚠️ 风险

[X 的自动化规则](https://help.x.com/en/rules-and-policies/x-automation)禁止通过脚本操作网站等非 API 自动化方式，使用本插件可能导致账号被限制，甚至永久停用。

插件采用预览后确认、默认 60 秒发布间隔、滚动 24 小时最多 20 条，以及默认可见的浏览器窗口来减少误发和过度操作；这些措施无法消除平台规则风险。需要官方支持的程序化发布方式时，请使用 [官方 X API](https://help.x.com/en/rules-and-policies/x-api)，并遵循相应规则。

登录使用不受自动化控制的普通 Chrome；预览和发布仍使用 CDP 控制的 Chrome，`navigator.webdriver` 为 `true`，X 可能将其视为自动化操作。这也是上述风险的一部分。

## 环境要求

- Node.js **≥ 22**，可在启动宿主的环境中运行 `node`。
- Google Chrome，或 Chromium / Microsoft Edge / Brave。默认自动查找，也可指定浏览器路径。
- 本机图形界面，用于用户自行登录和处理验证。

零依赖，无需为运行插件安装第三方 npm 包。

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

Codex 插件从 `.codex-mcp.json` 加载服务器配置。这里使用 `args: ["server/index.mjs"]` 和 `cwd: "."`，相对工作目录解析到安装后的插件根目录，不依赖 `${...}` 展开。`x_post`、`x_schedule` 和 `x_cancel_scheduled` 配置了 `approval_mode: "prompt"`，每次真实发布、创建或取消排期都要求宿主向用户请求审批；用户要求跳过预览时仍适用。

不使用插件时，可手动注册 MCP 服务器，并复制共享技能：

```bash
codex mcp add x-poster -- node "<绝对路径>/server/index.mjs"
mkdir -p ~/.codex/skills
cp -R "<本仓库路径>/skills/x-poster" ~/.codex/skills/
```

复制前检查目标是否已有同名技能，避免覆盖。手动注册的配置不自动继承插件的逐次 `x_post` / `x_schedule` / `x_cancel_scheduled` 审批设置，需保留技能中的预览确认流程；重启 Codex 后使用。

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

默认登录态由 Claude Code 和 Codex 共用。如果为不同宿主配置不同的 `X_POSTER_HOME`，它们使用各自目录中的会话。

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

## 工具参考

| 工具 | 参数 | 行为与结果 |
|---|---|---|
| `x_status` | 无 | 返回 `logged_in`、`username`、`login_window_open`、`posts_last_24h`、`last_post_at`、`next_post_allowed_in_sec`、`limits`、`headless`、`data_dir`。 |
| `x_login` | `wait_seconds?`（0–300，默认 0） | 用不受自动化控制的普通 Chrome 打开登录页或主页，支持 Google/Apple 登录，由用户自行操作。完成后按 Cmd+Q 完全退出该 Chrome（Windows/Linux 关闭它的所有窗口）。默认立即返回 `waiting_for_user` 或 `window_open`；1–300 最多等待相应秒数，用户退出后检查并返回登录态，否则继续等待用户操作，窗口无时限。 |
| `x_preview` | `text?`、`images?`、`scheduled_at?` | 填写发帖框，等待图片上传，保存并返回截图图像及路径，丢弃推文而不发布；返回 `weighted_length`，超过 280 时警告；带排期时间时预览排期并返回 `scheduled_at`（带偏移量）及 `scheduled_at_local`。 |
| `x_post` | `text?`、`images?` | 真实发布，返回 `id` 和 `url`。 |
| `x_schedule` | `text?`、`images?`、`scheduled_at`（必填） | 创建 X 原生预排期，返回 `scheduled: true`、`id`、`scheduled_at`、`scheduled_at_local`、`manage_url`。 |
| `x_list_scheduled` | 无 | 返回按时间排序的 `scheduled` 和 `count`；每项含 `id`、`scheduled_at`、`text`、`media_count`、`state`（未知时为 `null`）。 |
| `x_cancel_scheduled` | `id`（纯数字字符串） | 取消一个用户已明确确认的预排期帖；成功返回 `deleted: true`、`id` 和剩余数量 `remaining`，取消不计入发布额度。 |

`text` 为字符串，`images` 为本地路径数组。预览截图默认位于 `~/.x-poster/previews/`；预览不计入真实发布额度。

## 配置

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `X_POSTER_HOME` | `~/.x-poster` | 数据目录，包含专用 profile、历史、状态及保留 7 天的预览。 |
| `X_POSTER_CHROME_PATH` | 自动检测 | 浏览器可执行文件路径；自动检测依次尝试 Chrome、Chromium、Edge、Brave。 |
| `X_POSTER_HEADLESS` | `0` | 设为 `1` 后发布使用无窗口模式；登录始终显示窗口。 |
| `X_POSTER_MIN_INTERVAL_SEC` | `60` | 两次发布之间的最小秒数；`0` 关闭此限制。 |
| `X_POSTER_DAILY_LIMIT` | `20` | 滚动 24 小时的最大发布数量；`0` 关闭此限制。 |

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

Codex 在启动它的 shell 中设置变量；插件已通过 `env_vars` 放行上表的 5 个变量。例如：

```bash
export X_POSTER_HEADLESS=0
export X_POSTER_MIN_INTERVAL_SEC=60
export X_POSTER_DAILY_LIMIT=20
codex
```

修改后重启宿主或 MCP 服务器使配置生效。

## CLI 使用

在仓库根目录运行 `node server/cli.mjs <command>`：

| 命令 | 用途 |
|---|---|
| `status` | 查看登录态和发布统计。 |
| `login` | 打开普通 Chrome 供用户自行登录，等待该 Chrome 完全退出后确认登录态。 |
| `open` | 打开普通 Chrome 供用户登录或处理验证，等待该 Chrome 完全退出后检查登录态。 |
| `preview --text "…" [--image <path> …] [--at <ISO>]` | 预览，不发布；`--image` 可重复。 |
| `post --text "…" [--image <path> …]` | 真实发布；`--image` 可重复。 |
| `schedule --text "…" [--image <path> …] --at <ISO>` | 创建用户已预览确认的预排期；无偏移量时使用电脑本地时区。 |
| `scheduled` | 列出预排期帖子。 |
| `cancel --id <id>` | 取消一个预排期帖；先列出并向用户确认准确文字和时间。 |

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
```

CLI 会把 `--text` 中字面的 `\n` 转为换行，并允许相对图片路径；多图重复 `--image`。纯图片可省略 `--text`。CLI `post` 直接发布，`schedule` 直接创建排期，`cancel` 直接取消指定排期，没有 agent 的预览确认对话或 Codex 的工具审批，请在执行前核对内容。

## 数据与安全

默认数据目录为 `~/.x-poster`，可由 `X_POSTER_HOME` 更改：

| 路径 | 内容 |
|---|---|
| `chrome-profile/` | 专用 Chrome profile，包含敏感的 X 登录态。 |
| `history.jsonl` | 发布、排期和取消历史；取消记录不计入发布限制。 |
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
| Google 提示“此浏览器或应用可能不安全” | Google 拒绝在启用了远程调试端口的浏览器中登录。按 Cmd+Q 完全退出占用专用 profile 的 Chrome（Windows/Linux 关闭它的所有窗口），再调用 `x_login` 使用普通登录窗口。 |
| `NOT_LOGGED_IN` / 登录过期 | 调用 `x_login`，由用户重新登录并完全退出该 Chrome，再用 `x_status` 检查。 |
| `LOGIN_IN_PROGRESS` / `BROWSER_BUSY` | 请用户完成已有登录或检查操作，在该 Chrome 中按 Cmd+Q 完全退出（Windows/Linux 关闭它的所有窗口），再调用 `x_status`。仅关闭标签页可能仍占用专用 profile。 |
| `ACCOUNT_CHALLENGE` | 调用 `x_login`，由用户在普通窗口中自行完成验证，然后完全退出该 Chrome；不要绕过 CAPTCHA。 |
| `RATE_LIMITED` | 按 `retry_after_sec` 等待，不循环尝试。 |
| `BROWSER_NOT_FOUND` | 安装支持的浏览器，或设置 `X_POSTER_CHROME_PATH`。 |
| `BROWSER_LAUNCH_FAILED` | 检查浏览器路径与本机启动环境。 |
| `NETWORK_ERROR` | 检查网络连接；发布阶段失败时先核对主页，避免重复发送。 |
| `UPLOAD_FAILED` | 检查图片与连接，重新预览验证上传。 |
| `TEXT_REJECTED` | X 未接受文字，通常是过长；核对加权长度，修改后重新预览确认。 |
| `POST_REJECTED` | 阅读 X 返回的原因，例如重复内容或疑似自动化；停止，交由用户处理。 |
| `UI_CHANGED` | X 页面改版，需要更新 `server/x.mjs` 的 `SELECTORS`。 |
| `UNCERTAIN` | 无法确认是否已发出；**不要重试或重发**，请用户检查自己的主页；预排期创建或取消则检查“未发送的帖子 → 预排期”；若其他 id 消失，立即核查可能被误删的帖子。 |
| `INTERNAL_ERROR` | 停止操作，检查本地错误信息；不要公开敏感登录数据。 |
| GUI 宿主提示找不到 `node` | 确保宿主的 `PATH` 含 Node，或把 MCP 配置的 `command` 改为 Node 的绝对路径。 |

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
├── .codex-mcp.json             Codex MCP 配置，逐次审批 x_post / x_schedule / x_cancel_scheduled
├── .agents/plugins/marketplace.json  Codex 市场
├── skills/x-poster/SKILL.md     两种宿主共享的使用流程
├── server/
│   ├── index.mjs               MCP stdio 入口
│   ├── tools.mjs               工具定义与处理
│   ├── chrome.mjs              浏览器启动与 CDP
│   ├── x.mjs                   X 页面操作与 SELECTORS
│   ├── validate.mjs            输入校验与加权长度
│   ├── limits.mjs              发布历史与频率限制
│   ├── config.mjs              环境变量与路径
│   └── cli.mjs                 人工操作与调试入口
├── test/                       自动测试
├── package.json
├── .gitignore
└── README.md
```
