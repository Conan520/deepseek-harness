//! Tauri shell entry: builds the window application and delegates the dsh
//! backend child lifecycle to the [`backend`] module.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use tauri::{RunEvent, WebviewUrl};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = tauri::webview::WebviewWindowBuilder::new(app, backend::MAIN_WINDOW, WebviewUrl::default())
                .title("DeepSeek Harness")
                .inner_size(1280.0, 800.0)
                .visible(false)
                .on_navigation(backend::allow_navigation)
                .build()?;
            // Set the window icon at runtime: the taskbar shows the window's
            // icon, and Windows icon caches can otherwise keep serving the
            // resource icon from a previous installation at the same path.
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))
                .expect("the bundled window icon decodes");
            window.set_icon(icon)?;
            backend::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                backend::terminate(app);
            }
        });
}
