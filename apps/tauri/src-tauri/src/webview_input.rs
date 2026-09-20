//! Desktop input behavior for the WebView2 shell.
//!
//! A webview inherits browser behaviors a desktop shell must not have: the
//! default right-click menu (back, reload, save as, …), browser accelerator
//! keys (Alt+Left/Right, F5/Ctrl+R, F12, …), and history navigation driven by
//! the mouse side buttons. Tauri does not expose wry's
//! `with_default_context_menus` and `with_browser_accelerator_keys` switches,
//! so both settings are applied through the WebView2 COM handle.
//!
//! The side buttons cannot be filtered at the window level: WebView2 renders
//! into windows owned by the `msedgewebview2.exe` browser process, so their
//! messages never reach a window this process can subclass. WebView2 instead
//! reports why each navigation starts, and a `BackOrForward` navigation is
//! cancelled, which covers every input path into history: the side buttons, a
//! touchpad swipe, and a page-scripted `history.back()`.
//!
//! Windows-only; the other platforms keep the stock webview behavior.

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2NavigationStartingEventArgs3, ICoreWebView2Settings3,
    COREWEBVIEW2_NAVIGATION_KIND, COREWEBVIEW2_NAVIGATION_KIND_BACK_OR_FORWARD,
};
#[cfg(windows)]
use webview2_com::NavigationStartingEventHandler;
#[cfg(windows)]
use windows::core::Interface;

/// Apply the desktop input behavior to the main window's webview.
pub fn apply(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Err(error) = window.with_webview(configure_webview) {
        eprintln!("dsh: could not configure the webview input behavior: {error}");
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Configure one webview: turn off the browser-inherited behaviors, then
/// cancel history navigation.
#[cfg(windows)]
fn configure_webview(webview: tauri::webview::PlatformWebview) {
    let core_webview = match unsafe { webview.controller().CoreWebView2() } {
        Ok(core_webview) => core_webview,
        Err(error) => {
            eprintln!("dsh: could not reach the WebView2 core object: {error}");
            return;
        }
    };
    disable_browser_settings(&core_webview);
    cancel_history_navigation(&core_webview);
}

/// Turn off the WebView2 default context menu and the browser accelerator
/// keys. DOM `contextmenu` events still fire, so page-drawn menus keep
/// working.
#[cfg(windows)]
fn disable_browser_settings(core_webview: &ICoreWebView2) {
    let settings = match unsafe { core_webview.Settings() } {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("dsh: could not reach the WebView2 settings object: {error}");
            return;
        }
    };
    if let Err(error) = unsafe { settings.SetAreDefaultContextMenusEnabled(false) } {
        eprintln!("dsh: could not disable the WebView2 default context menu: {error}");
    }
    // Settings3 requires a WebView2 Runtime of at least 92.0.902.0; on an
    // older runtime only the accelerator keys stay active, and the cast
    // failure is reported so the gap is visible.
    match settings.cast::<ICoreWebView2Settings3>() {
        Ok(settings3) => {
            if let Err(error) = unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) } {
                eprintln!("dsh: could not disable the WebView2 browser accelerator keys: {error}");
            }
        }
        Err(error) => {
            eprintln!("dsh: could not reach the WebView2 accelerator-key settings: {error}");
        }
    }
}

/// Cancel every back/forward navigation, so no input path can leave the
/// current page for an earlier or later history entry.
///
/// Only cross-document traversals raise a cancelable navigation event; in-page
/// history traversal (fragment and History API entries) raises none, and this
/// UI keeps no such entries anyway.
#[cfg(windows)]
fn cancel_history_navigation(core_webview: &ICoreWebView2) {
    let handler = NavigationStartingEventHandler::create(Box::new(|_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        // Classifying the navigation needs
        // ICoreWebView2NavigationStartingEventArgs3 (WebView2 SDK
        // 1.0.1901.177 and later); where the interface is missing, the
        // navigation cannot be classified and is left alone.
        if let Ok(args3) = args.cast::<ICoreWebView2NavigationStartingEventArgs3>() {
            let mut kind = COREWEBVIEW2_NAVIGATION_KIND::default();
            if unsafe { args3.NavigationKind(&mut kind) }.is_ok() && cancels_navigation(kind) {
                unsafe { args.SetCancel(true) }?;
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    if let Err(error) = unsafe { core_webview.add_NavigationStarting(&handler, &mut token) } {
        eprintln!("dsh: could not install the history-navigation filter: {error}");
    }
}

/// Whether one navigation start is a history traversal to cancel.
///
/// Reloads and new documents stay allowed: the shell itself navigates to the
/// backend URL and to its error page, and the page may reload itself.
#[cfg(windows)]
fn cancels_navigation(kind: COREWEBVIEW2_NAVIGATION_KIND) -> bool {
    kind == COREWEBVIEW2_NAVIGATION_KIND_BACK_OR_FORWARD
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_NAVIGATION_KIND_NEW_DOCUMENT, COREWEBVIEW2_NAVIGATION_KIND_RELOAD,
    };

    #[test]
    fn history_traversal_is_cancelled() {
        assert!(cancels_navigation(COREWEBVIEW2_NAVIGATION_KIND_BACK_OR_FORWARD));
    }

    #[test]
    fn reloads_and_new_documents_are_allowed() {
        assert!(!cancels_navigation(COREWEBVIEW2_NAVIGATION_KIND_RELOAD));
        assert!(!cancels_navigation(COREWEBVIEW2_NAVIGATION_KIND_NEW_DOCUMENT));
    }
}
