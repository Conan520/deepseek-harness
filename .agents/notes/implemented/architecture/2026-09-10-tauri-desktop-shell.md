# Agent Note: Tauri developer shell around `dsh web`

Status: implemented

English | [中文](2026-09-10-tauri-desktop-shell.zh.md)

## Problem

`dsh web` serves a complete browser application on one authenticated loopback origin, but a developer working in a repository checkout gets it in a browser tab rather than a desktop window, and a machine without the checkout and a matching Node.js cannot use it at all. The repository needed one answer for how a Tauri shell may integrate: which surface it consumes, what it must not duplicate, how the backend child's lifetime stays bounded, and what an installation carries when the repository is absent.

## Decision

`apps/tauri` is a Tauri 2 shell that consumes only the public `dsh web` surface. From a checkout it spawns `node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 0` with the repository root as working directory; from an installation it spawns the bundled runtime next to the executable. Either child is launched through `tauri-plugin-shell` — the bundled interpreter as its sidecar binary, the source launch as a plain `node` command — so every program name the shell names is a compile-time literal and the plugin owns executable-path resolution. The shell parses the authenticated URL from the `dsh web: <url>` stdout line and navigates the system webview to it. Same-origin page semantics carry authentication, RPC, and the remote-stream WebSocket unchanged; the shell adds no transport, proxy, or custom protocol and grants the remote page no Tauri IPC. Navigation away from the loopback and shell origins goes to the system browser. Closing the window terminates the backend's whole process tree — `taskkill /PID <pid> /T /F` on Windows — because the backend spawns agent shells that must not outlive it.

The source launch refuses to start when the checkout lacks `node_modules` or `apps/web/dist/index.html`, naming the missing step on its error page. `DSH_TAURI_REPO` names a repository root explicitly when the binary runs outside the tree and fails loudly when the directory is not a repository root; the launch argument vector itself stays fixed in the shell, so environment values never select which program runs.

`pnpm package:tauri` stages the bundled runtime with `apps/tauri/scripts/prepare-runtime.mjs`: one SHASUMS256-verified upstream Node.js 24.17.0 executable and one production install of the published `@deepseek-ai/dsh` at its `latest` dist-tag (`DSH_TAURI_DSH_VERSION` pins an exact version instead), inside an isolated single-project pnpm workspace with a hoisted `node_modules`, so the NSIS installer's resources carry real directories only. Installed mode is detected by `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` sitting next to the executable; the installer is per-user win-x64 with an uninstaller, and installed state lives under the user's `$DSH_HOME` exactly as CLI usage does.

## Ownership

| Owner | Responsibility |
| --- | --- |
| `apps/tauri` Rust shell | Window lifecycle, launch-site resolution, stdout URL parsing, error page, process-tree termination |
| `apps/tauri/scripts/prepare-runtime.mjs` | Pinned Node.js download, isolated hoisted dsh runtime staging for the installer |
| `dsh web` bundle | URL-line format, port assignment, authentication, every transport the page uses |

## Consequences

The `dsh web: <url>` stdout line is a soft contract: its first whitespace-separated token must remain the authenticated loopback URL, or this shell's parser stops recognizing it. The bundled runtime floats with the npm `latest` dist-tag at packaging time, and transitive `^` ranges can resolve newer family members under the packaging machine's pnpm supply-chain policy; `DSH_TAURI_DSH_VERSION` pins an exact version when a frozen runtime is required. A crashed shell cannot clean up its backend (no Windows job object), so an abnormal shell exit can leave a node process behind for manual cleanup. The shell plugin cannot place the child in its own Unix process group, so Unix termination addresses the child and expects its subprocesses to follow; the installer itself targets win-x64 only. Upgrading the bundled dsh requires re-packaging and reinstalling — the shell has no in-app updater; apps/desktop keeps owning the transactional update flow.

## Alternatives considered

Replicating the Electron framed-pipe integration (a Rust `dsh-app://` carrier over the desktop-host protocol) was rejected: it duplicates the desktop-host wire protocol for no user-visible gain in this shell, and WebSocket semantics would still require the `__DSH_TRANSPORT__` page hooks. A fixed port was rejected in favor of `--port 0` plus URL-line parsing, which keeps concurrent shells conflict-free. Proxying the backend through a Tauri custom protocol was rejected because it breaks the page's same-origin assumptions for the WebSocket and cookie authentication. Packaging the runtime from local first-party tarballs (the apps/desktop seed machinery) was rejected for this scope: it duplicates the seed-store transactional machinery for a runtime the npm release lane already publishes coherently. Bundling the repository checkout itself was rejected: pnpm's symlinked `node_modules` does not survive installer resources.
