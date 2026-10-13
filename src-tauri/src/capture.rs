//! Quick capture and the tray (design.md D48), inside the one app process.
//!
//! The tray menu, the global shortcut and a second launch with `--capture` all end
//! in [`open_capture`]: show the main window and emit one event; the webview opens
//! the Capture dialog and does the rest. Closing the main window hides it while
//! "keep running in the tray" is on and the tray exists.
//!
//! Hiding and showing differ by platform, and only [`hide_main`] and [`reveal`] know
//! how. On macOS a hidden window leaves the app active with nothing to take the
//! keyboard, and a Dock click or Cmd+Tab does not bring it back (tauri#7540, #2149),
//! so there the whole app is hidden the way Cmd+H does it: focus goes back to the
//! previous app, the Dock icon stays, and Cmd+Tab or a Dock click unhides it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow, Window};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The event the webview listens to; the payload says how to put the window back.
pub const OPEN_CAPTURE: &str = "capture://open";
/// Emitted when a close of the main window hid it instead; the webview says so once.
pub const HIDDEN_TO_TRAY: &str = "capture://hidden-to-tray";
const MAIN: &str = "main";
const CAPTURE_ARG: &str = "--capture";

const TRAY_OPEN: &str = "tray-open";
const TRAY_CAPTURE: &str = "tray-capture";
const TRAY_QUIT: &str = "tray-quit";

const WAYLAND_REASON: &str = "Wayland does not let apps register global shortcuts.";

#[derive(Default)]
pub struct CaptureState {
    /// The "keep running in the tray" setting, sent by the webview. Off until then,
    /// so closing quits if the webview never starts.
    close_to_tray: AtomicBool,
    /// This process was started with `--capture`; the webview asks once.
    launch_capture: AtomicBool,
    /// Why there is no tray; `None` once the tray icon exists.
    tray_error: Mutex<Option<String>>,
    tray: AtomicBool,
    /// The accelerator currently registered, if any.
    shortcut: Mutex<Option<String>>,
}

impl CaptureState {
    pub fn new(launch_capture: bool) -> Self {
        let state = Self::default();
        state.launch_capture.store(launch_capture, Ordering::Relaxed);
        state
    }
}

/// How capture found the main window, so it can be put back the same way. On macOS
/// "hide" means the app was hidden (or the window ordered out) and hides the app again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Restore {
    Hide,
    Minimize,
}

#[derive(Clone, Serialize)]
struct OpenCapture {
    /// "hide" or "minimize" when capture had to show the window, else null.
    restore: Option<Restore>,
}

pub fn wants_capture<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter().any(|a| a.as_ref() == CAPTURE_ARG)
}

fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland")))
}

/// What the user cannot see of the main window: hidden (on macOS also the app being
/// hidden, whose windows report not visible) or minimised.
fn out_of_sight<R: Runtime>(window: &WebviewWindow<R>) -> Option<Restore> {
    if !window.is_visible().unwrap_or(true) {
        Some(Restore::Hide)
    } else if window.is_minimized().unwrap_or(false) {
        Some(Restore::Minimize)
    } else {
        None
    }
}

/// Unhides the app (macOS), then shows, unminimises and focuses the main window;
/// returns what it was before. On macOS `show` unhides the app and activates it, and
/// `set_focus` makes the window key and activates the app again, so typing reaches it.
fn reveal<R: Runtime>(app: &AppHandle<R>) -> Option<Restore> {
    let window = app.get_webview_window(MAIN)?;
    let restore = out_of_sight(&window);
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    restore
}

/// Takes the main window out of sight: on macOS hides the app (as Cmd+H), elsewhere
/// hides the window.
#[cfg(target_os = "macos")]
fn hide_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.hide()
}

#[cfg(not(target_os = "macos"))]
fn hide_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    match app.get_webview_window(MAIN) {
        Some(window) => window.hide(),
        None => Ok(()),
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    reveal(app);
}

pub fn open_capture<R: Runtime>(app: &AppHandle<R>) {
    let restore = reveal(app);
    let _ = app.emit_to(MAIN, OPEN_CAPTURE, OpenCapture { restore });
}

/// single-instance callback: `--capture` opens capture, anything else shows the window.
pub fn on_second_launch<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, _cwd: String) {
    if wants_capture(&args) {
        open_capture(app);
    } else {
        show_main(app);
    }
}

/// Whether a close request on the main window should hide it instead.
pub fn keep_in_tray<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<CaptureState>().is_some_and(|s| {
        s.close_to_tray.load(Ordering::Relaxed) && s.tray.load(Ordering::Relaxed)
    })
}

/// Hides the main window (the app on macOS) in place of closing it and tells the webview.
pub fn hide_to_tray<R: Runtime>(window: &Window<R>) {
    if hide_main(window.app_handle()).is_ok() {
        let _ = window.emit_to(MAIN, HIDDEN_TO_TRAY, ());
    }
}

/// The tray library is loaded at run time on Linux, and a missing one panics
/// (which aborts in release builds), so look for it first.
#[cfg(target_os = "linux")]
fn tray_library() -> Result<(), String> {
    const NAMES: [&str; 4] = [
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
        "libappindicator3.so",
    ];
    // SAFETY: loading these libraries runs no initialisers beyond GLib type setup,
    // the same load tray-icon performs when it builds the icon.
    if NAMES.iter().any(|name| unsafe { libloading::Library::new(name) }.is_ok()) {
        Ok(())
    } else {
        Err("The tray library is not installed (libayatana-appindicator3 or libappindicator3).".into())
    }
}

#[cfg(not(target_os = "linux"))]
fn tray_library() -> Result<(), String> {
    Ok(())
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN, "Open Secretary", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, TRAY_CAPTURE, "Capture...", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &capture, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Secretary")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN => show_main(app),
            TRAY_CAPTURE => open_capture(app),
            TRAY_QUIT => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Creates the tray icon; without one the app runs as before and Settings says why.
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) {
    let result = tray_library().and_then(|()| build_tray(app).map_err(|e| e.to_string()));
    let state = app.state::<CaptureState>();
    if let Err(reason) = &result {
        tauri_plugin_log::log::warn!("No tray icon: {reason}");
    }
    state.tray.store(result.is_ok(), Ordering::Relaxed);
    *state.tray_error.lock().unwrap() = result.err();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    tray: bool,
    tray_error: Option<String>,
    wayland: bool,
    /// True once, for the first call after a launch with `--capture`.
    launch_capture: bool,
}

#[tauri::command]
pub fn capture_status(state: State<'_, CaptureState>) -> CaptureStatus {
    CaptureStatus {
        tray: state.tray.load(Ordering::Relaxed),
        tray_error: state.tray_error.lock().unwrap().clone(),
        wayland: is_wayland(),
        launch_capture: state.launch_capture.swap(false, Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn set_close_to_tray(state: State<'_, CaptureState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

/// Puts the main window back the way capture found it (the `restore` of the open event).
#[tauri::command]
pub fn capture_restore(app: AppHandle, restore: Option<Restore>) -> Result<(), String> {
    match restore {
        Some(Restore::Hide) => hide_main(&app),
        Some(Restore::Minimize) => match app.get_webview_window(MAIN) {
            Some(window) => window.minimize(),
            None => Ok(()),
        },
        None => Ok(()),
    }
    .map_err(|e| e.to_string())
}

/// Whether the user cannot see the main window (hidden, the app hidden, or minimised).
#[tauri::command]
pub fn capture_window_hidden(app: AppHandle) -> bool {
    app.get_webview_window(MAIN)
        .is_none_or(|window| out_of_sight(&window).is_some())
}

/// Replaces the capture shortcut; an empty string turns it off. Async so the
/// plugin's main-thread dispatch does not wait on the main thread itself.
#[tauri::command]
pub async fn set_capture_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let state = app.state::<CaptureState>();
    let shortcuts = app.global_shortcut();
    let mut current = state.shortcut.lock().unwrap();
    if let Some(old) = current.take() {
        let _ = shortcuts.unregister(old.as_str());
    }
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        return Ok(());
    }
    if is_wayland() {
        return Err(WAYLAND_REASON.into());
    }
    shortcuts
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                open_capture(app);
            }
        })
        .map_err(|e| e.to_string())?;
    *current = Some(shortcut.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_flag_anywhere_in_the_arguments() {
        assert!(wants_capture(&["secretary", "--capture"]));
        assert!(wants_capture(&["/usr/bin/secretary", "-v", "--capture"]));
        assert!(!wants_capture(&["secretary"]));
        assert!(!wants_capture(&["secretary", "--capture=no"]));
    }

    /// The webview reads the open event's `restore` and sends it back unchanged.
    #[test]
    fn restore_matches_the_webview_payload() {
        let json = |restore| serde_json::to_string(&OpenCapture { restore }).unwrap();
        assert_eq!(json(Some(Restore::Hide)), r#"{"restore":"hide"}"#);
        assert_eq!(json(Some(Restore::Minimize)), r#"{"restore":"minimize"}"#);
        assert_eq!(json(None), r#"{"restore":null}"#);
        let parse = |s: &str| serde_json::from_str::<Option<Restore>>(s).ok();
        assert_eq!(parse(r#""hide""#), Some(Some(Restore::Hide)));
        assert_eq!(parse(r#""minimize""#), Some(Some(Restore::Minimize)));
        assert_eq!(parse("null"), Some(None));
        assert_eq!(parse(r#""close""#), None);
    }
}
