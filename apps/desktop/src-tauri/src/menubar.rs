use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};

const TRAY_ID: &str = "upbot";
const WINDOW_LABEL: &str = "menubar";

type TrayRect = (tauri::PhysicalPosition<f64>, tauri::PhysicalSize<f64>);

#[derive(Default)]
struct MenubarState {
    blurred_at: Mutex<Option<Instant>>,
    tray_rect: Mutex<Option<TrayRect>>,
    navigation: Mutex<MainNavigation>,
}

#[derive(Default)]
struct MainNavigation {
    ready: bool,
    pending: Option<String>,
}

impl MainNavigation {
    fn request(&mut self, view: String) -> Option<String> {
        if self.ready {
            Some(view)
        } else {
            self.pending = Some(view);
            None
        }
    }

    fn mounted(&mut self) -> Option<String> {
        self.ready = true;
        self.pending.take()
    }
}

fn keep_main_window(window: &tauri::WebviewWindow) {
    let handle = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window("main") {
                if let Err(error) = window.hide() {
                    log::warn!("could not hide main window: {error}");
                }
            }
        }
    });
}

fn menu_position(
    tray: Option<TrayRect>,
    size: tauri::PhysicalSize<u32>,
    monitor_position: tauri::PhysicalPosition<i32>,
    monitor_size: tauri::PhysicalSize<u32>,
    below_tray: bool,
) -> tauri::PhysicalPosition<i32> {
    let left = f64::from(monitor_position.x);
    let top = f64::from(monitor_position.y);
    let right = left + f64::from(monitor_size.width);
    let bottom = top + f64::from(monitor_size.height);
    let width = f64::from(size.width);
    let height = f64::from(size.height);
    let (x, y) = match tray {
        Some((position, size)) => {
            let above = position.y - height;
            (
                position.x + size.width / 2.0 - width / 2.0,
                if below_tray || above < top {
                    position.y + size.height
                } else {
                    above
                },
            )
        }
        None => (right - width, top),
    };
    tauri::PhysicalPosition::new(
        x.round().clamp(left, (right - width).max(left)) as i32,
        y.round().clamp(top, (bottom - height).max(top)) as i32,
    )
}

fn tray_tooltip(count: u32) -> String {
    if count == 0 {
        "UpBot".into()
    } else if count == 1 {
        "UpBot — 1 tarefa aguardando você".into()
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
    let state = app.state::<MenubarState>();
    let live_rect = app
        .tray_by_id(TRAY_ID)
        .and_then(|tray| tray.rect().ok().flatten())
        .map(|rect| {
            (
                rect.position.to_physical::<f64>(1.0),
                rect.size.to_physical::<f64>(1.0),
            )
        })
        .filter(|(_, size)| size.width > 0.0 && size.height > 0.0);
    if let Some(rect) = live_rect {
        *state.tray_rect.lock().unwrap() = Some(rect);
    }
    let rect = *state.tray_rect.lock().unwrap();
    let tray_monitor = match rect {
        Some((position, size)) => window.monitor_from_point(
            position.x + size.width / 2.0,
            position.y + size.height / 2.0,
        )?,
        None => None,
    };
    let monitor = tray_monitor
        .or(window.current_monitor()?)
        .or(app.primary_monitor()?)
        .ok_or_else(|| tauri::Error::Io(std::io::Error::other("No monitor found for menubar")))?;
    let position = menu_position(
        rect,
        window.outer_size()?,
        *monitor.position(),
        *monitor.size(),
        cfg!(target_os = "macos"),
    );
    window.set_position(position)?;
    window.show()?;
    window.set_focus()
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(MenubarState::default());
    if let Some(window) = app.get_webview_window("main") {
        keep_main_window(&window);
    }
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
            match &event {
                TrayIconEvent::Click { rect, .. }
                | TrayIconEvent::Enter { rect, .. }
                | TrayIconEvent::Leave { rect, .. }
                | TrayIconEvent::Move { rect, .. } => {
                    *app.state::<MenubarState>().tray_rect.lock().unwrap() = Some((
                        rect.position.to_physical::<f64>(1.0),
                        rect.size.to_physical::<f64>(1.0),
                    ));
                }
                _ => {}
            }
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
pub async fn open_main(app: AppHandle, view: Option<String>) -> Result<(), String> {
    let existing = app.get_webview_window("main");
    let navigation = {
        let state = app.state::<MenubarState>();
        let mut navigation = state.navigation.lock().unwrap();
        if existing.is_none() {
            navigation.ready = false;
        }
        view.and_then(|view| navigation.request(view))
    };
    let window = match existing {
        Some(window) => window,
        None => {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("Main window configuration not found")?;
            let window = WebviewWindowBuilder::from_config(&app, config)
                .map_err(|error| error.to_string())?
                .visible(false)
                .build()
                .map_err(|error| error.to_string())?;
            keep_main_window(&window);
            window
        }
    };
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    menubar_hide(app)?;
    window.set_focus().map_err(|error| error.to_string())?;
    if let Some(view) = navigation {
        window
            .emit("upbot://navigate", view)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn main_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can receive navigation".into());
    }
    let view = app
        .state::<MenubarState>()
        .navigation
        .lock()
        .unwrap()
        .mounted();
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
    fn navigation_waits_for_mount_and_delivers_the_latest_view_once() {
        let mut navigation = MainNavigation::default();
        assert_eq!(navigation.request("apps".into()), None);
        assert_eq!(navigation.request("bot-id".into()), None);
        assert_eq!(navigation.mounted(), Some("bot-id".into()));
        assert_eq!(navigation.mounted(), None);
        assert_eq!(navigation.request("apps".into()), Some("apps".into()));
        navigation.ready = false;
        assert_eq!(navigation.request("settings".into()), None);
        assert_eq!(navigation.mounted(), Some("settings".into()));
    }

    fn position(
        tray: Option<(f64, f64)>,
        origin: (i32, i32),
        below: bool,
    ) -> tauri::PhysicalPosition<i32> {
        menu_position(
            tray.map(|(x, y)| {
                (
                    tauri::PhysicalPosition::new(x, y),
                    tauri::PhysicalSize::new(30.0, 30.0),
                )
            }),
            tauri::PhysicalSize::new(384, 600),
            tauri::PhysicalPosition::new(origin.0, origin.1),
            tauri::PhysicalSize::new(1600, 1200),
            below,
        )
    }

    #[test]
    fn macos_anchors_both_axes_to_tray_not_previous_window_position() {
        assert_eq!(
            position(Some((1330.0, 0.0)), (0, 0), true),
            tauri::PhysicalPosition::new(1153, 30)
        );
    }

    #[test]
    fn tray_positions_clamp_to_each_monitor_edge() {
        assert_eq!(
            position(Some((0.0, 0.0)), (0, 0), true),
            tauri::PhysicalPosition::new(0, 30)
        );
        assert_eq!(
            position(Some((1590.0, 1190.0)), (0, 0), true),
            tauri::PhysicalPosition::new(1216, 600)
        );
        assert_eq!(
            position(Some((-270.0, -1200.0)), (-1600, -1200), true),
            tauri::PhysicalPosition::new(-447, -1170)
        );
    }

    #[test]
    fn windows_bottom_tray_opens_above_and_top_tray_opens_below() {
        assert_eq!(
            position(Some((1330.0, 1170.0)), (0, 0), false),
            tauri::PhysicalPosition::new(1153, 570)
        );
        assert_eq!(
            position(Some((1330.0, 0.0)), (0, 0), false),
            tauri::PhysicalPosition::new(1153, 30)
        );
        assert_eq!(
            position(Some((-270.0, -1200.0)), (-1600, -1200), false),
            tauri::PhysicalPosition::new(-447, -1170)
        );
    }

    #[test]
    fn missing_tray_uses_monitor_top_right() {
        assert_eq!(
            position(None, (0, 0), true),
            tauri::PhysicalPosition::new(1216, 0)
        );
        assert_eq!(
            position(None, (-1600, -1200), false),
            tauri::PhysicalPosition::new(-384, -1200)
        );
    }

    #[test]
    fn physical_retina_rects_and_oversized_windows_are_clamped() {
        assert_eq!(
            menu_position(
                Some((
                    tauri::PhysicalPosition::new(2660.0, 0.0),
                    tauri::PhysicalSize::new(60.0, 60.0)
                )),
                tauri::PhysicalSize::new(768, 1200),
                tauri::PhysicalPosition::new(0, 0),
                tauri::PhysicalSize::new(3200, 2400),
                true,
            ),
            tauri::PhysicalPosition::new(2306, 60)
        );
        assert_eq!(
            menu_position(
                None,
                tauri::PhysicalSize::new(768, 1200),
                tauri::PhysicalPosition::new(-100, 50),
                tauri::PhysicalSize::new(200, 100),
                true
            ),
            tauri::PhysicalPosition::new(-100, 50)
        );
    }

    #[test]
    fn empty_count_clears_title_and_tooltip() {
        assert_eq!(tray_title(0), "");
        assert_eq!(tray_tooltip(0), "UpBot");
    }

    #[test]
    fn pending_count_is_shown_without_truncation() {
        assert_eq!(tray_tooltip(1), "UpBot — 1 tarefa aguardando você");
        assert_eq!(tray_title(1), "1");
        for count in [3, u32::MAX] {
            assert_eq!(tray_title(count), count.to_string());
            assert_eq!(
                tray_tooltip(count),
                format!("UpBot — {count} tarefas aguardando você")
            );
        }
    }
}
