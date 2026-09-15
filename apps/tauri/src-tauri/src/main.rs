//! Tauri shell entry: builds the visible loading window, the tray icon, and
//! the close-to-tray behavior, and delegates the dsh backend child lifecycle
//! to the [`backend`] module.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WebviewUrl, WindowEvent,
};

/// User-facing strings for one locale. Tray copy follows the system
/// language: Chinese when the locale starts with `zh`, English otherwise,
/// mirroring the Electron desktop shell's locale handling.
struct Copy {
    tray_open: &'static str,
    tray_quit: &'static str,
}

const ZH: Copy = Copy {
    tray_open: "打开 DeepSeek Harness",
    tray_quit: "退出",
};

const EN: Copy = Copy {
    tray_open: "Open DeepSeek Harness",
    tray_quit: "Quit",
};

fn copy_for() -> &'static Copy {
    let chinese = sys_locale::get_locale()
        .map(|locale| locale.to_lowercase().starts_with("zh"))
        .unwrap_or(false);
    if chinese { &ZH } else { &EN }
}

fn main() {
    tauri::Builder::default()
        // Single instance first: a second launch must exit before its setup
        // creates a window or spawns a backend, and its only effect is the
        // callback below raising the first instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(backend::MAIN_WINDOW) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = tauri::webview::WebviewWindowBuilder::new(app, backend::MAIN_WINDOW, WebviewUrl::default())
                .title("DeepSeek Harness")
                .inner_size(1280.0, 800.0)
                .on_navigation(backend::allow_navigation)
                .build()?;
            // Set the window icon at runtime: the taskbar shows the window's
            // icon, and Windows icon caches can otherwise keep serving the
            // resource icon from a previous installation at the same path.
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))
                .expect("the bundled window icon decodes");
            window.set_icon(icon.clone())?;

            let copy = copy_for();
            let open = MenuItem::with_id(app, "open", copy.tray_open, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", copy.tray_quit, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("DeepSeek Harness")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window(backend::MAIN_WINDOW) {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window(backend::MAIN_WINDOW) {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            backend::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // The close button minimizes to the tray instead of closing: the
            // backend session stays alive and the tray menu's quit is the
            // only way out. `app.exit` bypasses CloseRequested, so quitting
            // from the tray never re-enters this handler.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                backend::terminate(app);
            }
        });
}
