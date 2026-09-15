# DeepSeek Harness Tauri

[English](README.md) | 中文

`apps/tauri` 是具有两种启动位置的 Tauri 2 壳。在仓库检出中，它从源码启动 `dsh web` 子进程；在安装中，它启动捆绑运行时（固定版本的上游 Node.js 与已发布的 `@deepseek-ai/dsh`）。无论哪种方式，壳都等待后端打印到 stdout 的带认证回环 URL，再让系统 webview 加载该地址。页面以同源方式加载，`/api` 请求、`/api/remote.mux` WebSocket 与 token 换 Cookie 的认证流程原样运行；壳自身不引入任何传输层。

## 先决条件

开发本壳需要带 MSVC 工具链的 Rust、WebView2（Windows 10/11 预装）以及本仓库的 Node.js 和 pnpm；先在仓库根目录执行一次 `pnpm install` 和 `pnpm run build`。当 `node_modules` 或 `apps/web/dist/index.html` 缺失时，源码启动会拒绝启动后端，并在错误页上指出缺失的步骤。打包额外需要网络访问：Tauri CLI 首次使用时会下载 NSIS 工具。

## 用法

以下命令均在仓库根目录执行：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:tauri` | 从源码针对本检出运行本壳（开发模式） |
| `pnpm build:tauri` | 仅构建 release 可执行文件，不含安装包 |
| `pnpm prepare:tauri` | 仅准备捆绑运行时（Node.js + dsh） |
| `pnpm package:tauri` | 准备捆绑运行时并产出 NSIS 安装包 |
| `pnpm --filter @deepseek-ai/dsh-tauri run icons` | 确定性地重新生成图标集 |

安装包产出路径为 `apps/tauri/src-tauri/target/release/bundle/nsis/DeepSeek Harness_<版本>_x64-setup.exe`。从源码运行本壳需要先构建仓库（`pnpm install` && `pnpm run build`）；打包不需要，因为打包会从 npm 安装已发布的 dsh。

窗口创建后立即显示品牌化 loading 页，后端公布 URL 后导航到 Web UI。本壳为单实例：再次启动可执行文件会让新进程立即退出，并弹出已有窗口。关闭窗口会直接最小化到系统托盘，会话保持运行；托盘图标左键恢复窗口，右键菜单提供打开与退出。退出会终止后端整个进程树：Windows 上执行 `taskkill /T /F`，Unix 上对进程先 TERM 后 KILL。托盘文案跟随系统语言（中文或英文）。

`DSH_TAURI_REPO` 在二进制于仓库外启动时显式指定仓库根目录；被指定的目录必须包含 `pnpm-workspace.yaml` 和 `apps/cli`，否则启动会大声失败。

## 排障

如果新安装的构建在开始菜单快捷方式或任务栏按钮上仍显示旧图标，这是 Windows 图标缓存按安装路径缓存所致，卸载重装不会清除。用 `ie4uinit.exe -show` 刷新，或注销后重新登录。要验证构建本身，可以提取 `dsh.exe` 的图标，或在打包前检查 `apps/tauri/src-tauri/icons/icon.ico`。图标可用 `pnpm --filter @deepseek-ai/dsh-tauri run icons` 确定性地重新生成。

## 安装包

准备阶段以 SHASUMS256 校验下载固定版本的 Node.js 24.17.0，并把已发布 `@deepseek-ai/dsh` 的 `latest` dist-tag 安装进隔离的 hoisted 工作区（无符号链接，因此整棵树可作为安装包资源分发）；捆绑的解释器以 Tauri sidecar 方式运行。`DSH_TAURI_DSH_VERSION` 可固定精确 dsh 版本以取代 dist-tag，`DSH_TAURI_NODE_MIRROR` 可覆盖 Node.js 下载源。安装包面向 win-x64，按用户安装且无需提权，并自带卸载器。

安装将状态保存在用户的 `$DSH_HOME`（默认 `~/.dsh`）下，与任何 CLI 用法共享；与 `dsh web` 一样需要 DeepSeek API 凭据——在用户环境中设置 `DEEPSEEK_API_KEY`，或在启动会话前通过 Web UI 设置配置凭据。升级捆绑的 dsh 意味着重新执行 `pnpm package:tauri` 并重装；本壳没有应用内更新器。

## 范围

本壳捆绑了自己的 Node.js 与 dsh 运行时，因此安装后既不需要仓库也不需要系统 Node.js。产品级的分发（隔离运行时、更新流程与 macOS 支持）仍由 [Electron 桌面应用](../desktop/README.zh.md)承担。集成决策记录在 [Tauri 壳 Agent Note](../../.agents/notes/implemented/architecture/2026-09-10-tauri-desktop-shell.zh.md)。
