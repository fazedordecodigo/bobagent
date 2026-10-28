use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};

const TRAY_ID: &str = "upbot";
const WINDOW_LABEL: &str = "menubar";

#[derive(Default)]
struct MenubarState {
    blurred_at: Mutex<Option<Instant>>,
}

fn tray_tooltip(count: u32) -> String {
    if count == 0 {
        "UpBot".into()
    } else {
        format!("UpBot — {count} tarefas aguardando você")
    }
}

#[cfg(any(target_os = "macos", test))]
fn tray_title(count: u32) -> String {
    if count == 0 {
        String::new()
    } else {
        count.to_string()
    }
}

fn toggle(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or(tauri::Error::WindowNotFound)?;
    if window.is_visible()? {
        return window.hide();
    }

    let position = if cfg!(target_os = "macos") {
        Position::TrayBottomCenter
    } else {
        Position::TrayCenter
    };
    if let Err(error) = window.move_window_constrained(position) {
        log::debug!("tray position unavailable, using top-right: {error}");
        window.move_window(Position::TopRight)?;
    }
    #[cfg(target_os = "macos")]
    if let Some(rect) = app
        .tray_by_id(TRAY_ID)
        .and_then(|tray| tray.rect().ok().flatten())
    {
        let position = window.outer_position()?;
        // The positioner anchors at the icon's origin; keep the window below the menu bar.
        let bottom =
            rect.position.to_physical::<f64>(1.0).y + rect.size.to_physical::<f64>(1.0).height;
        window.set_position(tauri::PhysicalPosition::new(
            position.x,
            bottom.round() as i32,
        ))?;
    }
    window.show()?;
    window.set_focus()
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(MenubarState::default());
    let window = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("index.html#/menubar".into()),
    )
    .title("UpBot")
    .inner_size(384.0, 600.0)
    .resizable(false)
    .decorations(false)
    // macOS transparency would require opting into private APIs.
    .transparent(!cfg!(target_os = "macos"))
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .shadow(true)
    .build()?;
    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            *handle.state::<MenubarState>().blurred_at.lock().unwrap() = Some(Instant::now());
            if let Err(error) = menubar_hide(handle.clone()) {
                log::warn!("could not hide menubar: {error}");
            }
        }
    });

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray-symbol.png"
        ))?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(tray_tooltip(0))
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            tauri_plugin_positioner::on_tray_event(app, &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Clicking the tray can blur and hide the popover before the click arrives.
                let blurred_at = app
                    .state::<MenubarState>()
                    .blurred_at
                    .lock()
                    .unwrap()
                    .take();
                if blurred_at.is_some_and(|time| time.elapsed() < Duration::from_millis(250)) {
                    return;
                }
                if let Err(error) = toggle(app) {
                    log::warn!("could not toggle menubar: {error}");
                }
            }
        })
        .build(app)?;

    let modifiers = Modifiers::ALT
        | if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
    app.global_shortcut().on_shortcut(
        Shortcut::new(Some(modifiers), Code::KeyU),
        |app, _, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(error) = toggle(app) {
                    log::warn!("could not toggle menubar: {error}");
                }
            }
        },
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_tray_count(app: AppHandle, count: u32) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("UpBot tray icon not found")?;
    #[cfg(target_os = "macos")]
    tray.set_title(Some(tray_title(count)))
        .map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tray_tooltip(count)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn menubar_hide(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("Menubar window not found")?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_main(app: AppHandle, view: Option<String>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    menubar_hide(app)?;
    window.set_focus().map_err(|error| error.to_string())?;
    if let Some(view) = view {
        window
            .emit("upbot://navigate", view)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_count_clears_title_and_tooltip() {
        assert_eq!(tray_title(0), "");
        assert_eq!(tray_tooltip(0), "UpBot");
    }

    #[test]
    fn pending_count_is_shown_without_truncation() {
        for count in [1, 3, u32::MAX] {
            assert_eq!(tray_title(count), count.to_string());
            assert_eq!(
                tray_tooltip(count),
                format!("UpBot — {count} tarefas aguardando você")
            );
        }
    }
}
