//! dsh backend child lifecycle: resolve a launch site (the installer's
//! bundled runtime, or this repository's source), launch `dsh web`, hand the
//! authenticated loopback URL to the main window, and terminate the whole
//! process tree on application exit.
//!
//! The shell owns no transport of its own. `dsh web` serves the Web UI, the
//! `/api` JSON-RPC route, and the `/api/remote.mux` WebSocket on one loopback
//! origin; the webview loads the token-authenticated URL printed to the
//! child's stdout, so every request the page makes is same-origin and passes
//! the server's loopback trust fence unchanged.
//!
//! Both launch sites go through `tauri-plugin-shell`: the bundled interpreter
//! is its sidecar binary and the source launch is a plain `node` command, so
//! every program name the shell names is a compile-time literal and the
//! plugin owns all executable-path resolution.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Wall-clock budget for the first `dsh web: …` stdout line; a first source
/// launch loads the full plugin tree through tsx.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
/// Label of the main window created in the shell's setup hook.
pub const MAIN_WINDOW: &str = "main";
/// Bytes of child stderr kept for the error page.
const STDERR_TAIL_BYTES: usize = 16 * 1024;
/// Bytes of one error message kept for the error-page query string.
const MESSAGE_BYTES: usize = 4096;
/// Environment variable naming the repository root to launch from, instead
/// of discovering it from the working directory.
const REPO_OVERRIDE_ENV: &str = "DSH_TAURI_REPO";
/// `lib/bin.js` of the installed `@deepseek-ai/dsh` package, relative to the
/// installation root (the directory holding this executable).
const PACKAGED_DSH_BIN: &str = "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js";
/// Upper bound for one unterminated stdout line buffered while splitting
/// stream chunks; the URL line is far below this.
const STDOUT_LINE_BUFFER_BYTES: usize = 64 * 1024;

/// One observed backend state change on the startup or monitoring path.
enum BackendEvent {
    /// The child printed its authenticated loopback URL.
    Ready(String),
    /// The child process exited with this code (None: killed by a signal).
    Exited(Option<i32>),
}

/// Shared slot holding the live child's pid for exit-time tree termination.
struct PidSlot(Mutex<Option<u32>>);

/// Start the backend lifecycle for one application run.
pub fn start(app: AppHandle) {
    app.manage(PidSlot(Mutex::new(None)));
    std::thread::spawn(move || run(app));
}

/// Where this run launches `dsh web` from.
enum LaunchSite {
    /// An installation's resource root carrying the bundled runtime.
    Packaged { root: PathBuf },
    /// This repository's root, launching the CLI through tsx from source.
    Source { repo: PathBuf },
}

/// Resolve the launch site, spawn the child, and drive the window through
/// readiness, startup failure, and mid-session exit.
fn run(app: AppHandle) {
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let Some(site) = resolve_launch_site(&app, &stderr_tail) else {
        return
    };
    let (receiver, child) = match launch(&app, &site) {
        Ok(spawned) => spawned,
        Err(message) => {
            report_error(&app, &message, &stderr_tail);
            return
        }
    };
    let pid = child.pid();
    *app.state::<PidSlot>().0.lock().expect("pid slot mutex") = Some(pid);
    let (tx, rx) = mpsc::channel::<BackendEvent>();
    spawn_event_pump(receiver, Arc::clone(&stderr_tail), tx);
    match rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(BackendEvent::Ready(url)) => show_backend(&app, &url),
        Ok(BackendEvent::Exited(code)) => report_error(
            &app,
            &format!("the dsh web backend exited before announcing its URL ({})", exit_description(code)),
            &stderr_tail,
        ),
        Err(_) => {
            kill_tree(pid);
            report_error(&app, "timed out waiting for the dsh web URL line on the backend's stdout", &stderr_tail);
        }
    }
    // After readiness the only remaining event is the child's exit; swap the
    // live UI for the error page so a backend crash is never a silent hang.
    while let Ok(event) = rx.recv() {
        if let BackendEvent::Exited(code) = event {
            report_error(
                &app,
                &format!("the dsh web backend stopped ({})", exit_description(code)),
                &stderr_tail,
            );
        }
    }
}

/// Resolve where this run launches `dsh web` from, reporting blockers on the
/// error page and returning `None` when no site is viable.
fn resolve_launch_site(app: &AppHandle, stderr_tail: &Arc<Mutex<String>>) -> Option<LaunchSite> {
    if let Some(root) = packaged_root() {
        return Some(LaunchSite::Packaged { root })
    }
    let Some(repo) = find_repo_root() else {
        report_error(
            app,
            "could not locate the deepseek-harness repository root: no pnpm-workspace.yaml above the working directory; run from the repository or set DSH_TAURI_REPO",
            stderr_tail,
        );
        return None
    };
    let blockers = startup_blockers(&repo);
    if !blockers.is_empty() {
        report_error(app, &blockers.join("; "), stderr_tail);
        return None
    }
    Some(LaunchSite::Source { repo })
}

/// The installation root carrying the bundled runtime, when this shell runs
/// from an installation; `None` in a repository checkout.
fn packaged_root() -> Option<PathBuf> {
    let root = std::env::current_exe().ok()?.parent()?.to_path_buf();
    (root.join(PACKAGED_DSH_BIN).is_file()).then_some(root)
}

/// Spawn `dsh web` for one launch site through the shell plugin.
fn launch(
    app: &AppHandle,
    site: &LaunchSite,
) -> Result<(tokio::sync::mpsc::Receiver<CommandEvent>, CommandChild), String> {
    match site {
        LaunchSite::Packaged { root } => app
            .shell()
            .sidecar("node")
            .map_err(|error| format!("could not resolve the bundled node sidecar: {error}"))?
            .args([PACKAGED_DSH_BIN, "web", "--no-open", "--port", "0"])
            .current_dir(root)
            .spawn()
            .map_err(|error| format!("could not start the bundled dsh web backend: {error}")),
        LaunchSite::Source { repo } => app
            .shell()
            .command("node")
            .args(["--import", "tsx/esm", "apps/cli/src/bin.ts", "web", "--no-open", "--port", "0"])
            .current_dir(repo)
            .spawn()
            .map_err(|error| format!("could not start the dsh web backend: {error}")),
    }
}

/// Drain the child's stream events: split stdout into lines and forward the
/// authenticated URL, keep a bounded stderr tail, and report the exit code.
///
/// The pump keeps consuming after the URL match so a full pipe never blocks
/// the backend.
fn spawn_event_pump(
    mut receiver: tokio::sync::mpsc::Receiver<CommandEvent>,
    stderr_tail: Arc<Mutex<String>>,
    events: Sender<BackendEvent>,
) {
    tauri::async_runtime::spawn(async move {
        let mut pending: Vec<u8> = Vec::new();
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(chunk) => {
                    pending.extend_from_slice(&chunk);
                    while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
                        let drained: Vec<u8> = pending.drain(..=position).collect();
                        let line = String::from_utf8_lossy(&drained);
                        if let Some(url) = authenticated_url_from_line(&line) {
                            let _ = events.send(BackendEvent::Ready(url));
                        }
                    }
                    if pending.len() > STDOUT_LINE_BUFFER_BYTES {
                        pending.clear();
                    }
                }
                CommandEvent::Stderr(chunk) => push_stderr_tail(&stderr_tail, &chunk),
                CommandEvent::Terminated(payload) => {
                    let _ = events.send(BackendEvent::Exited(payload.code));
                    break;
                }
                CommandEvent::Error(message) => push_stderr_tail(&stderr_tail, message.as_bytes()),
                _ => {}
            }
        }
    });
}

/// Append one stderr chunk to the bounded display tail.
fn push_stderr_tail(tail: &Arc<Mutex<String>>, chunk: &[u8]) {
    let mut tail = tail.lock().expect("stderr tail mutex");
    tail.push_str(&String::from_utf8_lossy(chunk));
    let excess = tail.len().saturating_sub(STDERR_TAIL_BYTES);
    if excess > 0 {
        let mut cut = excess;
        while cut < tail.len() && !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

/// Render a child exit code for an error message.
fn exit_description(code: Option<i32>) -> String {
    match code {
        Some(code) => format!("exit code {code}"),
        None => "terminated by a signal".to_owned(),
    }
}

/// Extract the authenticated loopback URL from one `dsh web` stdout line.
///
/// The full line can carry a trailing `(LAN: …)` display suffix, which the
/// first-whitespace-token cut drops.
fn authenticated_url_from_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix("dsh web: ")?;
    let candidate = rest.split_whitespace().next()?;
    let is_authenticated = candidate.starts_with("http://127.0.0.1:") && candidate.contains("/?token=");
    is_authenticated.then(|| candidate.to_owned())
}

/// Locate the repository that provides `apps/cli` and the workspace manifest.
///
/// An explicit `DSH_TAURI_REPO` must name a repository root or the launch
/// fails loudly; otherwise candidates walk up from the working directory and
/// from the compile-time manifest directory, so both `pnpm dev:tauri` and a
/// directly invoked in-repo binary find the tree.
fn find_repo_root() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var(REPO_OVERRIDE_ENV) {
        if !raw.trim().is_empty() {
            let named = PathBuf::from(raw.trim());
            return is_repo_root(&named).then_some(named);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    candidates
        .iter()
        .flat_map(|start| start.ancestors())
        .find(|dir| is_repo_root(dir))
        .map(Path::to_path_buf)
}

/// Whether one directory is this repository's root.
fn is_repo_root(dir: &Path) -> bool {
    dir.join("pnpm-workspace.yaml").is_file() && dir.join("apps/cli").is_dir()
}

/// Repository states `dsh web` from source cannot boot from.
fn startup_blockers(repo: &Path) -> Vec<String> {
    let mut blockers = Vec::new();
    if !repo.join("node_modules").is_dir() {
        blockers.push("`node_modules` is missing: run `pnpm install` at the repository root first".to_owned());
    }
    if !repo.join("apps/web/dist/index.html").is_file() {
        blockers.push("`apps/web/dist/index.html` is missing: run `pnpm run build` at the repository root first".to_owned());
    }
    blockers
}

/// Move the main window onto the authenticated backend URL.
fn show_backend(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    match Url::parse(url) {
        Ok(parsed) => {
            if let Err(error) = window.navigate(parsed) {
                report_error(app, &format!("could not navigate the window to {url}: {error}"), &Arc::new(Mutex::new(String::new())));
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => report_error(
            app,
            &format!("the backend announced an unparsable URL {url}: {error}"),
            &Arc::new(Mutex::new(String::new())),
        ),
    }
}

/// Log one failure and swap the shell page to its error state.
fn report_error(app: &AppHandle, message: &str, stderr_tail: &Arc<Mutex<String>>) {
    let tail = stderr_tail.lock().expect("stderr tail mutex").clone();
    eprintln!("dsh: {message}");
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let origin = window
        .url()
        .ok()
        .and_then(|url| url_origin(&url))
        .unwrap_or_else(|| "http://tauri.localhost".to_owned());
    let target = format!(
        "{origin}/?error={}&stderr={}",
        percent_encode(&truncate_utf8(message, MESSAGE_BYTES)),
        percent_encode(&truncate_utf8(&tail, STDERR_TAIL_BYTES)),
    );
    match Url::parse(&target) {
        Ok(parsed) => {
            let _ = window.navigate(parsed);
        }
        Err(error) => eprintln!("dsh: could not build the error-page URL: {error}"),
    }
    let _ = window.show();
}

/// `scheme://host[:port]` of a page URL.
fn url_origin(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// Decide one main-frame navigation.
///
/// Loopback pages and the shell's own origin stay in the webview; anything
/// else opens in the system browser so product links never replace the UI.
pub fn allow_navigation(url: &Url) -> bool {
    let host = url.host_str();
    let is_loopback_page = matches!(url.scheme(), "http" | "https")
        && matches!(host, Some("127.0.0.1") | Some("localhost") | Some("[::1]"));
    let is_shell_page = url.scheme() == "tauri" || url.scheme() == "about" || host == Some("tauri.localhost");
    if is_loopback_page || is_shell_page {
        true
    } else {
        open_external(url);
        false
    }
}

/// Hand one URL to the operating system's default browser or handler.
fn open_external(url: &Url) {
    let target = url.as_str();
    let status = {
        #[cfg(target_os = "windows")]
        {
            let mut command = std::process::Command::new("rundll32");
            command.args(["url.dll,FileProtocolHandler", target]);
            suppress_console_window(&mut command);
            command.status()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(target).status()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(target).status()
        }
    };
    if let Err(error) = status {
        eprintln!("dsh: could not open {target} with the system handler: {error}");
    }
}

/// Keep a spawned console program from opening a visible console window.
///
/// This process runs windowed (no console of its own), so Windows would
/// allocate one for each console child — a visible flash per spawn.
#[cfg(target_os = "windows")]
fn suppress_console_window(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Terminate the backend and every process it spawned.
pub fn terminate(app: &AppHandle) {
    let pid = app.state::<PidSlot>().0.lock().expect("pid slot mutex").take();
    if let Some(pid) = pid {
        kill_tree(pid);
    }
}

/// Platform process-tree termination for one backend child.
fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        // The backend spawns agent shells; /T reaches the whole tree and /F
        // avoids console-dependent graceful-shutdown paths.
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        suppress_console_window(&mut command);
        if let Err(error) = command.status() {
            eprintln!("dsh: could not terminate the backend process tree: {error}");
        }
    }
    #[cfg(unix)]
    {
        // The shell plugin cannot place the child in its own process group,
        // so termination addresses the child only; its subprocesses are
        // expected to follow their parent's shutdown.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_secs(2));
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// Percent-encode every byte outside the unreserved set.
fn percent_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Shorten one string to at most `max` bytes without splitting a character.
fn truncate_utf8(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}
