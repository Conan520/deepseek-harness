# Agent Note: 包裹 `dsh web` 的 Tauri 壳

Status: implemented

[English](2026-09-10-tauri-desktop-shell.md) | 中文

## Problem

`dsh web` 在一个带认证的回环源上伺服完整的浏览器应用，但在仓库检出中工作的开发者只能在浏览器标签页里使用它；而没有检出与匹配 Node.js 的机器则完全无法使用。仓库需要一个关于 Tauri 壳如何集成的统一答案：它消费哪个表面、不得复制什么、后端子进程的生命周期如何保持有界，以及仓库缺席时安装要携带什么。

## Decision

`apps/tauri` 是只消费公开 `dsh web` 表面的 Tauri 2 壳。从检出中，它以仓库根目录为工作目录派生 `node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 0`；从安装中，它派生可执行文件旁的捆绑运行时。两种子进程都经 `tauri-plugin-shell` 启动——捆绑解释器作为其 sidecar 二进制，源码启动作为普通 `node` 命令——因此壳命名的每个程序名都是编译期字面量，可执行路径解析由插件承担。壳从 `dsh web: <url>` stdout 行解析出带认证的 URL，并让系统 webview 导航过去。壳持有进程生命周期的单实例锁（`tauri-plugin-single-instance`，先于所有其他插件注册，使第二次启动在创建窗口或后端之前退出）；其回调负责弹出第一个实例的窗口。窗口自创建起即可见，显示一张品牌化静态 loading 页，导航发生时由 Web UI 替换；启动错误也渲染在同一页面。同源页面语义原样承载认证、RPC 与远程流 WebSocket；壳不引入传输、代理或自定义协议，也不向远程页面授予任何 Tauri IPC。离开回环源与壳自身源的导航交给系统浏览器。关闭请求直接最小化到托盘：窗口隐藏，鲸鱼托盘图标保持应用可达——左键恢复，右键菜单提供打开与退出，菜单中的退出（`app.exit(0)`）是离开托盘状态的唯一出口。只有真正终止才执行 `taskkill /PID <pid> /T /F`（Windows），因为后端会派生不应比它存活更久的 agent shell；驻留托盘的应用保持后端与会话存活。

当检出缺少 `node_modules` 或 `apps/web/dist/index.html` 时，源码启动拒绝启动并在错误页上指出缺失的步骤。`DSH_TAURI_REPO` 在二进制于仓库外运行时显式指定仓库根目录，目录不是仓库根时启动大声失败；启动参数向量本身固定在壳里，环境值永远不能选择运行哪个程序。

`pnpm package:tauri` 通过 `apps/tauri/scripts/prepare-runtime.mjs` 准备捆绑运行时：一个经 SHASUMS256 校验的上游 Node.js 24.17.0 可执行文件，以及已发布 `@deepseek-ai/dsh` 的 `latest` dist-tag 的一次生产安装（`DSH_TAURI_DSH_VERSION` 可固定精确版本），位于隔离的单项目 pnpm 工作区并使用 hoisted `node_modules`，因此 NSIS 安装包的资源只携带真实目录。安装模式通过可执行文件旁存在 `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` 检测；安装包面向按用户的 win-x64 并自带卸载器，安装状态与 CLI 用法一样保存在用户的 `$DSH_HOME` 下。

## Ownership

| 归属 | 职责 |
| --- | --- |
| `apps/tauri` Rust 壳 | 窗口生命周期、启动位置解析、stdout URL 解析、错误页、进程树终止 |
| `apps/tauri/scripts/prepare-runtime.mjs` | 固定版本 Node.js 下载、面向安装包的隔离 hoisted dsh 运行时准备 |
| `dsh web` bundle | URL 行格式、端口分配、认证、页面使用的全部传输 |

## Consequences

`dsh web: <url>` stdout 行是一个软契约：它的第一个空白分隔 token 必须仍是带认证的回环 URL，否则本壳的解析器不再识别它。捆绑运行时在打包时随 npm `latest` dist-tag 浮动，传递 `^` 范围在打包机的 pnpm 供应链策略下可以解析到更新的家族成员；需要冻结运行时时用 `DSH_TAURI_DSH_VERSION` 固定精确版本。崩溃的壳无法清理其后端（没有 Windows job object），异常退出可能遗留需要手动清理的 node 进程。驻留托盘的壳对扫视任务栏的用户而言与崩溃无异，且关闭按钮不再提供任何退出途径——鲸鱼托盘图标（Windows 11 默认收进溢出区）及其菜单中的退出项是唯一的恢复与退出入口。shell 插件无法把子进程放入独立的 Unix 进程组，因此 Unix 终止只针对子进程本体并期望其孙进程跟随关闭；安装包本身仅面向 win-x64。升级捆绑的 dsh 需要重新打包并重装——本壳没有应用内更新器；事务性更新流程仍由 apps/desktop 承担。

## Alternatives considered

复刻 Electron 分帧管道集成（用 Rust 实现基于 desktop-host 协议的 `dsh-app://` 载体）被否决：它在本壳里换不来任何用户可见收益，却要复制 desktop-host 线协议，且 WebSocket 语义仍需 `__DSH_TRANSPORT__` 页面钩子。固定端口被否决，改用 `--port 0` 加 URL 行解析，使多个并行壳互不冲突。通过 Tauri 自定义协议代理后端被否决，因为它破坏页面在 WebSocket 与 Cookie 认证上的同源假设。用本地第一方 tarball 打包运行时（apps/desktop 的 seed 机制）在此范围被否决：npm 发布通道已经连贯地发布该运行时，复制 seed-store 事务机制没有价值。直接捆绑仓库检出被否决：pnpm 基于符号链接的 `node_modules` 无法在安装包资源中存活。
