---
name: gdufs-auth-session
description: 管理广东外语外贸大学统一身份认证与图书馆 VPN 会话，将登录态缓存到用户目录，供国际法检索等其它 skill 复用；只负责认证和会话，不负责具体数据库检索。
---

# GDUFS Auth Session

> **`<skill-dir>`** = 本 SKILL.md 所在目录。核心脚本为 `<skill-dir>/scripts/gdufs_auth.py`，Windows 下用 `<skill-dir>/run.ps1` 调用。

这个 skill 只做一件事：登录一次广外统一身份认证并完成图书馆 `智慧广外登录` 和 `libvpn.gdufs.edu.cn` VPN 会话建立，然后把会话 Cookie 缓存到一个用户级文件。其它 skill 通过 `ensure` 复用该会话，不再各自登录。

## 为什么单独拆出

广外登录有会话限制。多个检索工具如果各自登录，会互相踢下线或快速消耗会话。正确顺序是：

1. 由本 skill 调用 `ensure`；
2. 其它 skill 读取 `cookies`；
3. 其它 skill 使用同一份 VPN 会话访问需要机构权限的资源。

本 skill 不保存用户名密码到 skill 目录，也不把密码写入会话文件。密码来自：

- `--config <path>` 指定的 JSON 配置文件；或
- 环境变量 `GDUFS_USERNAME` / `GDUFS_PASSWORD`。

默认配置路径为 `<用户配置目录>/gdufs-auth/config.json`。默认会话路径为 `<用户缓存目录>/gdufs-auth/session.json`，也可以用 `--session` 或 `GDUFS_AUTH_SESSION` 覆盖。

## 命令

```powershell
# 首次登录或强制刷新
& '<skill-dir>/run.ps1' login --config '<config.json>' --session '<session.json>'

# 检查当前会话；valid=true 表示 VPN 登录态仍有效
& '<skill-dir>/run.ps1' status --config '<config.json>' --session '<session.json>'

# 其它 skill 的推荐入口：有效则复用，失效则登录
& '<skill-dir>/run.ps1' ensure --config '<config.json>' --session '<session.json>'

# 输出 Cookie JSON，供无头浏览器或其它 HTTP 工具使用
& '<skill-dir>/run.ps1' cookies --session '<session.json>' --out '<cookies.json>'

# 查看非敏感会话元数据
& '<skill-dir>/run.ps1' inspect --session '<session.json>'

# 清除本地会话
& '<skill-dir>/run.ps1' clear --session '<session.json>'

# 查看/设置当前 Codex 会话是否启用基于浏览器的来源
& '<skill-dir>/run.ps1' browser-preference get
& '<skill-dir>/run.ps1' browser-preference set --enabled true
& '<skill-dir>/run.ps1' browser-preference set --enabled false
```

`ensure` 在会话有效时返回 `status=reused`，只有失效时才重新登录。并发调用同一个 session 文件时会等待锁，避免同时登录。

浏览器来源偏好按 `CODEX_THREAD_ID`（没有时退回到当前 GDUFS 会话指纹）保存。检索工具首次遇到浏览器来源时会返回 `needs_user_input`，由助手询问用户；用户回答后用上面的 `browser-preference set` 记住本会话选择，之后同一会话不再重复询问。

## 通用浏览器取页

部分机构资源（例如 HeinOnline）使用 Service Worker 和浏览器风控，不能只用普通 HTTP 客户端读取。本 skill 提供一个通用的无头浏览器辅助脚本：

```powershell
node '<skill-dir>/scripts/headless_fetch.mjs' `
  --cookies '<cookies.json>' `
  --url '<https://libvpn.gdufs.edu.cn/-https://example.org/>' `
  --out '<rendered.html>' `
  --search-term '<search terms>' `
  --search-input '<css selector>' `
  --search-submit '<css selector>' `
  --result-url-contains '<url fragment>'
```

脚本只负责注入会话、执行页面 JavaScript、可选地填写并提交检索表单，然后输出渲染后的 HTML。具体数据库的检索词、选择器和结果解析属于调用方 skill。

Chrome/Chromium 路径优先读取 `CHROME_PATH`，其次自动查找常见安装位置。找不到浏览器时脚本会明确失败，不会静默改用无登录请求。

## 通用浏览器下载

LibVPN 对每个新浏览器配置的首次请求返回 Service Worker 安装页，因此 curl/requests 取不到被代理的资源，PDF 等文件下载也必须走真实浏览器。脚本 `<skill-dir>/scripts/headless_download.mjs` 注入同一份 Cookie，等 Service Worker 接管后再让 Chrome 落盘：

```powershell
node '<skill-dir>/scripts/headless_download.mjs' `
  --cookies '<cookies.json>' `
  --url '<真正的下载链接>' `
  --warmup '<同站点普通页面链接，可省略>' `
  --out '<本地文件.pdf>'
```

- `--url` 是下载地址（例如 HeinOnline 的 `HOL/PrintRequest?...&print=section&format=PDFsearchable`）。`--warmup` 指向同站点普通页面，用来触发 Service Worker 安装；省略时脚本按目标 URL 的 `handle`/`collection` 推导一个 `HOL/Page` 预热页，再退回站点首页。
- 实测 2026-10-15：预热页落在 `HOL/Page` 目录时 Service Worker 才接管，用站点根或 `HOL/` 预热会一直停在安装页。作用域跟着资源路径目录走，换路径时不要复用同一个预热页。
- LibVPN 只在 `/-https://<host><path>` 入口形式下代理内容；带 `__proto__=https&__host__=<host>` 的结果链接是 Service Worker 生效后的形式，普通 HTTP 客户端直接请求只会拿到安装页，调用方需先改写为入口形式。
- 输出 JSON 含 `status`、`method`（`navigation`/`click`/`in-page-fetch`）、`bytes`、`sha256`、`service_worker_controlled`、`warmup_url` 和 `warnings`。只有 `status=ok` 表示落盘的是 PDF；其它响应写到 `<out>.html` 供排查。
- 会话可能中途过期（`status --session ...` 返回 `expired`）：先 `ensure` 再重跑，不要把安装页或登录页当成数据库拒绝访问。

## 使用边界

- 仅用于用户已获授权的广外账号和图书馆资源。
- 不绕过验证码、订阅或数据库自身的访问控制；目标站明确拒绝自动化访问时，报告限制，不继续规避。
- 不要把 `session.json`、`cookies.json` 或含 Cookie 的调试文件提交到仓库。
- 不要把用户名密码写入检索报告、日志、缓存键或引用信息。
- 会话失效时先跑 `status`；只有 `valid=false` 才重新登录。

详细会话格式、锁和恢复策略见 [references/session.md](references/session.md)。
