# gdufs-auth-session（公开）部署指引

管理广东外语外贸大学统一身份认证与图书馆 `libvpn.gdufs.edu.cn` VPN 会话，把登录态缓存到用户目录，供 HeinOnlineSearcher 等检索 skill 复用。**本 skill 只负责认证、会话和通用无头浏览器取页/下载，不负责任何数据库的检索逻辑。**

## 运行环境

| 组件 | 要求 |
| --- | --- |
| Python | 3.10+，依赖见 `requirements.txt`（`requests`、`lxml`、`pycryptodome`） |
| PowerShell | Windows PowerShell 5.1 或 PowerShell 7+（`pwsh`）；macOS/Linux 需安装 `pwsh` |
| Node.js | 22+（`headless_fetch.mjs` / `headless_download.mjs` 使用全局 `WebSocket`） |
| 浏览器 | Chrome / Chromium / Edge，可用 `CHROME_PATH` 指定 |

## 安装

```powershell
git clone https://github.com/HuiwowICCSkills/gdufs-auth-session.git "$env:USERPROFILE\.codex\skills\gdufs-auth-session"
python -m pip install -r "$env:USERPROFILE\.codex\skills\gdufs-auth-session\requirements.txt"
```

本仓库是公开仓库：需要 HuiwowICCSkills 组织成员权限，或配置有读权限的部署密钥/令牌。

## 配置凭据

默认配置文件 `%USERPROFILE%\.gdufs-auth\config.json`（macOS/Linux：`~/.config/gdufs-auth/config.json`）：

```json
{
  "username": "<广外账号>",
  "password": "<密码>",
  "verify_ssl": true,
  "timeout_seconds": 30
}
```

也可以用环境变量 `GDUFS_USERNAME` / `GDUFS_PASSWORD`，或用 `--config` 指向别处的配置文件。凭据不写入会话文件，也不要提交到 Git。

## 命令

```powershell
$auth = "$env:USERPROFILE\.codex\skills\gdufs-auth-session\run.ps1"

& $auth login   --config '<config.json>' --session '<session.json>'   # 首次登录或强制刷新
& $auth status  --config '<config.json>' --session '<session.json>'   # 检查会话；valid=true 才有效
& $auth ensure  --config '<config.json>' --session '<session.json>'   # 推荐入口：有效则复用，失效则登录
& $auth cookies --session '<session.json>' --out '<cookies.json>'     # 导出 Cookie 给无头浏览器
& $auth inspect --session '<session.json>'                            # 非敏感元数据
& $auth clear   --session '<session.json>'                            # 清除本地会话

& $auth browser-preference get                                        # 查看本 Codex 会话的浏览器来源偏好
& $auth browser-preference set --enabled true
```

## 默认路径

| 内容 | Windows | macOS/Linux |
| --- | --- | --- |
| 会话 | `%USERPROFILE%\.gdufs-auth\session.json` | `~/.cache/gdufs-auth/session.json` |
| 凭据配置 | `%USERPROFILE%\.gdufs-auth\config.json` | `~/.config/gdufs-auth/config.json` |
| 浏览器来源偏好 | `%USERPROFILE%\.gdufs-auth\browser_sources.json` | `~/.cache/gdufs-auth/browser_sources.json` |

均可用 `--session` / `--config` 或 `GDUFS_AUTH_SESSION` / `GDUFS_AUTH_CONFIG` 覆盖。详细会话结构、锁与恢复策略见 [references/session.md](references/session.md)。

## 供其它 skill 复用

调用方按「`--auth-skill` → `GDUFS_AUTH_SKILL` → 同级 `gdufs-auth-session/` 目录」定位本 skill，然后：

1. `run.ps1 ensure` 复用或建立会话；
2. `run.ps1 cookies --out <临时文件>` 导出 Cookie；
3. `node scripts/headless_fetch.mjs --cookies ... --url ... --out ...` 渲染需要登录态的页面；
4. `node scripts/headless_download.mjs --cookies ... --url ... --out ...` 下载 PDF；LibVPN 的 Service Worker 需要先用同路径预热页接管；
5. 删除临时 Cookie 文件。

## 使用边界

- 仅用于用户已获授权的广外账号和图书馆资源。
- 不绕过验证码、订阅或数据库自身的访问控制；目标站明确拒绝自动化访问时报告限制。
- `session.json`、`cookies.json` 和含 Cookie 的调试文件都是 bearer 凭据，不要提交到仓库、日志或检索报告。
- 并发调用同一个会话文件时用 `ensure`，不要并发 `login`：本 skill 用 `<session>.lock` 串行化登录。

## 排错

| 现象 | 处理 |
| --- | --- |
| `status` 返回 `expired` / `missing` | 跑 `ensure` 重新登录；确认 config.json 中的账号密码正确 |
| `invalid credentials` / 登录被拒 | 检查账号是否开通图书馆 VPN、密码是否过期，必要时在浏览器登录一次确认 |
| 页面渲染停在安装页 | 确认 Chrome 路径（`CHROME_PATH`）、会话未过期；LibVPN 需要 `/-https://<host><path>` 入口形式 |
| `node: not found` | 安装 Node.js 22+ |
| macOS/Linux 下 `run.ps1` 无法执行 | 安装 PowerShell 7（`pwsh`） |
