mod capture;
mod obsidian;
mod secrets;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};

const CLOSE_WINDOW: &str = "close-window";

/// Tauri's default macOS menu, except Close Window has no Cmd+W shortcut, so
/// Cmd+W (or Ctrl+W on keyboards that swap them) reaches the app, which uses it
/// to delete the previous word (D38).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };
    let close = MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &close,
                ],
            )?,
        ],
    )
}

/// One running instance (D48). A debug build on Linux registers under its own
/// D-Bus name, so `tauri dev` runs beside an installed copy instead of handing over
/// to it.
fn single_instance<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_single_instance::Builder::new().callback(capture::on_second_launch);
    #[cfg(all(debug_assertions, target_os = "linux"))]
    let builder = builder.dbus_id("dev.rickliu.secretary.dev");
    builder.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must be the first plugin: a second launch hands its arguments over and exits here.
    let builder = tauri::Builder::default();
    let builder = match capture::switched_off(capture::NO_SINGLE_INSTANCE) {
        Some(reason) => {
            eprintln!("No single-instance plugin: {reason}");
            builder
        }
        None => builder.plugin(single_instance()),
    };
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        if event.id().as_ref() == CLOSE_WINDOW {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
    });
    let launch_capture = capture::wants_capture(&std::env::args().collect::<Vec<_>>());
    let builder = match capture::switched_off(capture::NO_SHORTCUT) {
        Some(reason) => {
            eprintln!("No global shortcut plugin: {reason}");
            builder
        }
        None => builder.plugin(tauri_plugin_global_shortcut::Builder::new().build()),
    };
    builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                // D34: logs stay small, at most three files of 2 MB.
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            app.manage(capture::CaptureState::new(launch_capture));
            capture::create_tray(app.handle());
            Ok(())
        })
        // Every close of the main window (the app's close button, Alt+F4, the red
        // button, Close Window) arrives here; it hides to the tray when that is on.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && capture::keep_in_tray(window.app_handle()) {
                    api.prevent_close();
                    capture::hide_to_tray(window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            obsidian::obsidian_cli,
            capture::capture_status,
            capture::set_close_to_tray,
            capture::set_capture_shortcut,
            capture::capture_restore,
            capture::capture_window_hidden
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon unhides the app and focuses the window (D48).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                capture::show_main(_app);
            }
        });
}
