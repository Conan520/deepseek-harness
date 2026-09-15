# DeepSeek Harness Tauri

English | [中文](README.zh.md)

`apps/tauri` is a Tauri 2 shell around the dsh Web UI with two launch sites. In a repository checkout it starts `dsh web` from source as a child process; in an installation it starts the bundled runtime (a pinned upstream Node.js and the published `@deepseek-ai/dsh`). Either way the shell waits for the authenticated loopback URL the backend prints to stdout and points the system webview at it. The page loads same-origin, so `/api` requests, the `/api/remote.mux` WebSocket, and the token-to-cookie authentication run unchanged; the shell adds no transport of its own.

## Prerequisites

Developing the shell needs Rust with the MSVC toolchain, WebView2 (preinstalled on Windows 10/11), and the repository's Node.js and pnpm; run `pnpm install` and `pnpm run build` at the repository root once. The source launch refuses to start while `node_modules` or `apps/web/dist/index.html` is missing and names the missing step on its error page. Packaging additionally needs network access: the Tauri CLI downloads NSIS tooling on first use.

## Usage

Commands run from the repository root:

| Command | What it does |
| --- | --- |
| `pnpm dev:tauri` | Run the shell from source against this checkout (development) |
| `pnpm build:tauri` | Build the release executable only, no installer |
| `pnpm prepare:tauri` | Stage the bundled runtime only (Node.js + dsh) |
| `pnpm package:tauri` | Stage the bundled runtime and produce the NSIS installer |
| `pnpm --filter @deepseek-ai/dsh-tauri run icons` | Regenerate the icon set deterministically |

The installer lands at `apps/tauri/src-tauri/target/release/bundle/nsis/DeepSeek Harness_<version>_x64-setup.exe`. Running the shell from source needs the repository built first (`pnpm install` && `pnpm run build`); packaging does not, because it installs the published dsh from npm instead.

The window appears immediately with a branded loading page and navigates to the Web UI once the backend announces its URL. The shell is single-instance: launching the executable again exits the new process and raises the existing window instead. Closing the window minimizes it to the system tray, keeping the session running; the tray icon restores the window on left click, and its right-click menu offers open and quit. Quitting terminates the backend process tree: `taskkill /T /F` on Windows, TERM then KILL on Unix. Tray copy follows the system language (Chinese or English).

`DSH_TAURI_REPO` names the repository root explicitly when the binary is started outside the tree; the named directory must contain `pnpm-workspace.yaml` and `apps/cli`, otherwise startup fails loudly.

## Troubleshooting

If a freshly installed build still shows the previous icon on its Start-menu shortcut or taskbar button, that is the Windows icon cache keyed on the install path, which survives uninstall/reinstall. Refresh it with `ie4uinit.exe -show`, or sign out and back in. Verify the build itself by extracting the icon from `dsh.exe` or by checking `apps/tauri/src-tauri/icons/icon.ico` before packaging.

## Installer

Staging downloads the pinned Node.js 24.17.0 with SHASUMS256 verification and installs the published `@deepseek-ai/dsh` at its `latest` dist-tag into an isolated hoisted workspace (no symlinks, so the tree ships as installer resources); the staged interpreter runs as a Tauri sidecar. `DSH_TAURI_DSH_VERSION` pins an exact dsh version instead of the dist-tag, and `DSH_TAURI_NODE_MIRROR` overrides the Node.js download root. The installer targets win-x64, installs per-user without elevation, and carries an uninstaller.

An installation keeps its state under the user's `$DSH_HOME` (default `~/.dsh`), shared with any CLI usage, and needs a DeepSeek API credential the same way `dsh web` does — set `DEEPSEEK_API_KEY` in the user environment or configure the credential through the Web UI settings before starting a session. Upgrading the bundled dsh means re-running `pnpm package:tauri` and reinstalling; the shell has no in-app updater.

## Scope

The shell bundles its own Node.js and dsh runtime, so installations need neither the repository nor a system Node.js. The [Electron desktop application](../desktop/README.md) remains the product-grade distribution with its isolated runtime, update flow, and macOS support. The [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-10-tauri-desktop-shell.md) records the integration decisions.
