---
name: x-poster
description: >-
  通过本机 Chrome 预览并发布 X 推文，支持文字和最多 4 张本地图片。
  用户说“发推”“发 X”“发推特”“把这段话/这张图发到 X”（包括“把这段话发到 X”“把这张图发到 X”）、
  “post to X”“post on Twitter”或“tweet this”时使用；调用 x_status、x_login、x_preview、x_post 四个 MCP 工具。
---

# X 推文发布

使用 MCP 服务器 `x-poster`，默认先预览、确认，再发布。

## 工作流程

1. 调用 `x_status`（无参数），查看登录态、用户名与发布额度。
2. 若 `logged_in` 为 false，调用 `x_login`，告诉用户在不受自动化控制的普通 Chrome 窗口里自行登录，可使用 Google/Apple 账号，包括双重认证。
   - 绝不索要或输入密码；登录由用户本人完成。
   - `x_login` 的 `wait_seconds` 默认是 `0`，立即返回 `waiting_for_user`（已登录时为 `window_open`）；设为 1–300 时最多等待相应秒数，用户完全退出该 Chrome 后才检查登录态并返回 `logged_in` 和 `status`，否则返回等待状态。窗口没有时限。
   - 完成登录后，请用户在该 Chrome 中按 **Cmd+Q 完全退出**（Windows/Linux：关闭它的所有窗口），然后告诉你已完成；再调用 `x_status` 确认登录态。
   - 若返回 `LOGIN_IN_PROGRESS` 或 `BROWSER_BUSY`，提示用户完成并退出已有窗口，不重复启动登录。
   - 已登录时调用 `x_login` 会打开普通 Chrome 的 X 主页，供用户自行处理验证提示；完成后同样需要完全退出该 Chrome。
3. 若 `next_post_allowed_in_sec` 大于 0，告诉用户还需等待多少秒，不循环尝试发布。
4. 准备内容与图片。
   - 用户提供的文字逐字保留，包括换行、标点与 emoji。
   - 自行起草时先展示草稿，供用户审阅。
   - `text` 和 `images` 至少提供一项；允许纯文字或纯图片。
   - `images` 是最多 4 个绝对本地路径，可使用 `~`；图片 URL 必须先下载到本地。
   - 格式限 jpg、jpeg、png、webp、gif；每张图片最多 5 MB，GIF 最多 15 MB。
   - 中文等 CJK 字符与 emoji 按 2 计，链接按 23 计；非 Premium 账号上限为 280。
5. 用最终的 `text`、`images` 调用 `x_preview`。
   - 工具填入发帖框、等待上传完成并截图，然后丢弃推文，不发布。
   - 向用户展示返回的截图图像、截图路径和最终文字；纯图片时明确说明无文字。
   - 截图默认保存在 `~/.x-poster/previews/`；查看 `weighted_length` 和超出 280 的警告。
   - 等待用户对这份内容的**明确确认**；修改文字或图片后重新预览并确认。
   - 仅当用户在本次请求中明确要求“直接发布，无需确认”时跳过预览确认。
6. 使用完全相同的 `text`、`images` 调用 `x_post`，成功后回报 `url`（结果也包含 `id`）。
   - Codex 插件为每次 `x_post` 配置工具审批；直接发布的请求仍须遵循宿主审批。
   - 发布前如登录态或额度发生变化，先处理对应错误。

## 错误处理

| 错误码 | 行动 |
|---|---|
| `INVALID_INPUT` | 说明参数问题，核对文字、路径、格式、数量和大小；更改内容后重新预览确认。 |
| `NOT_LOGGED_IN` | 调用 `x_login`，让用户在普通 Chrome 中自行登录并按 Cmd+Q 完全退出（Windows/Linux 关闭它的所有窗口），再用 `x_status` 确认。 |
| `LOGIN_IN_PROGRESS` | 请用户完成已有登录窗口中的操作，按 Cmd+Q 完全退出该 Chrome（Windows/Linux 关闭它的所有窗口），再调用 `x_status`；不重复启动登录。 |
| `ACCOUNT_CHALLENGE` | 调用 `x_login` 打开普通窗口，让用户自行完成验证后完全退出该 Chrome；绝不绕过 CAPTCHA。 |
| `RATE_LIMITED` | 告知 `retry_after_sec`，等待额度恢复；不循环重试，也不擅自降低限制。 |
| `BROWSER_NOT_FOUND` | 请用户安装 Chrome、Chromium、Edge 或 Brave，或设置 `X_POSTER_CHROME_PATH`。 |
| `BROWSER_BUSY` | 请用户完成登录或账号检查，按 Cmd+Q 完全退出占用专用 profile 的 Chrome（Windows/Linux 关闭它的所有窗口），再调用 `x_status`。 |
| `BROWSER_LAUNCH_FAILED` | 检查浏览器路径和启动环境，解决启动问题后再继续。 |
| `NETWORK_ERROR` | 告知网络失败并检查连接；真实发布失败时先核对主页，避免盲目重发。 |
| `UPLOAD_FAILED` | 检查图片与网络，重新预览确认上传完成，再请求发布。 |
| `TEXT_REJECTED` | 解释 X 拒绝文字，核对加权长度；请用户修改或审阅新草稿后重新预览。 |
| `POST_REJECTED` | 展示 X 的拒绝原因，例如重复内容或疑似自动化；停止发布，交由用户决定。 |
| `UI_CHANGED` | 告知页面选择器失效，需要维护 `server/x.mjs` 中的 `SELECTORS`。 |
| `UNCERTAIN` | **绝不重试**；请用户检查自己的 X 主页，确认是否已发出。 |
| `INTERNAL_ERROR` | 停止并报告意外错误；诊断时不暴露登录态等敏感数据。 |

## 规则

- 只发布用户明确确认的内容；本次明确要求直接发布视为授权该次指定内容。
- 不批量发帖、不发垃圾内容、不重复发布相同推文。
- 遇到 `UNCERTAIN` 永不重试，即使暂时未找到推文，也交由用户核查。
- 绝不绕过 CAPTCHA 或账号验证。
- 绝不处理密码：不询问、不输入、不存储。
- 登录态位于专用数据目录，两种宿主共用；不要读取或展示 cookie。
- 预览不会发布；不得把预览截图当作发布成功的证据。
