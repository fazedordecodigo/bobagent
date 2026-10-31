#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod menubar;
mod notifications;

use rand::RngCore;
use serde::Serialize;
use std::ffi::OsStr;
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Notify;

const READY_PREFIX: &str = "BOTO_READY ";

fn parse_ready_port(json: &str) -> Result<u16, &'static str> {
    let value = serde_json::from_str::<serde_json::Value>(json)
        .map_err(|_| "botod READY line is not valid JSON")?;
    value["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
        .ok_or("botod READY has no valid port")
}

#[derive(Serialize, Clone)]
struct DaemonConnection {
    port: u16,
    token: String,
}

#[derive(Default)]
struct DaemonInner {
    conn: Option<DaemonConnection>,
    error: Option<String>,
    child: Option<CommandChild>,
}

struct DaemonState {
    inner: Mutex<DaemonInner>,
    ready: Notify,
}

type SharedState = Arc<DaemonState>;

fn hex_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn migrate_data_dir(data_dir: &std::path::Path) -> Result<(), String> {
    if data_dir.exists() {
        return Ok(());
    }
    if let Some(parent) = data_dir.parent() {
        for identifier in ["com.upbot.desktop", "com.bobagent.desktop"] {
            let legacy = parent.join(identifier);
            if legacy.is_dir() {
                std::fs::rename(&legacy, data_dir)
                    .map_err(|e| format!("could not migrate {identifier} data dir: {e}"))?;
                break;
            }
        }
    }
    Ok(())
}

fn spawn_daemon(app: &tauri::App) -> Result<(), String> {
    let state: SharedState = app.state::<SharedState>().inner().clone();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    migrate_data_dir(&data_dir)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create data dir: {e}"))?;
    let token = hex_token();

    let sidecar = app
        .shell()
        .sidecar("botod")
        .map_err(|e| format!("sidecar: {e}"))?;
    let (mut rx, mut child) = sidecar
        .args([OsStr::new("--data-dir"), data_dir.as_os_str()])
        .spawn()
        .map_err(|e| format!("spawn botod: {e}"))?;
    // deliver the auth token on the daemon's first stdin line
    child
        .write(format!("{token}\n").as_bytes())
        .map_err(|e| format!("write token to botod stdin: {e}"))?;

    {
        let mut inner = state.inner.lock().unwrap();
        inner.child = Some(child);
    }

    let task_state = state.clone();
    tauri::async_runtime::spawn(async move {
        let state = task_state;
        let mut stdout_buf = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(idx) = stdout_buf.find('\n') {
                        let line = stdout_buf[..idx].trim_end().to_string();
                        stdout_buf = stdout_buf[idx + 1..].to_string();
                        if let Some(json) = line.strip_prefix(READY_PREFIX) {
                            match parse_ready_port(json) {
                                Ok(port) => {
                                    let mut inner = state.inner.lock().unwrap();
                                    inner.conn = Some(DaemonConnection {
                                        port,
                                        token: token.clone(),
                                    });
                                }
                                Err(msg) => {
                                    log::error!("{msg}");
                                    state.inner.lock().unwrap().error = Some(msg.to_string());
                                }
                            }
                            state.ready.notify_waiters();
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        log::info!("botod: {line}");
                    }
                }
                CommandEvent::Error(e) => log::error!("botod error: {e}"),
                CommandEvent::Terminated(status) => {
                    log::warn!("botod terminated: {status:?}");
                    {
                        let mut inner = state.inner.lock().unwrap();
                        inner.conn = None;
                        inner.child = None;
                        inner.error = Some(format!("botod exited: {status:?}"));
                    }
                    state.ready.notify_waiters();
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn daemon_connection(state: State<'_, SharedState>) -> Result<DaemonConnection, String> {
    loop {
        let notified = state.ready.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let inner = state.inner.lock().unwrap();
            if let Some(conn) = &inner.conn {
                return Ok(conn.clone());
            }
            if let Some(err) = &inner.error {
                return Err(err.clone());
            }
        }
        notified.await;
    }
}

fn main() {
    let shared: SharedState = Arc::new(DaemonState {
        inner: Mutex::new(DaemonInner::default()),
        ready: Notify::new(),
    });

    tauri::Builder::default()
        .manage(notifications::NotificationState::from_args(
            &std::env::args().collect::<Vec<_>>(),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            notifications::forward_launch(app, &args);
            if let Err(e) = notifications::notifications_open(app.clone()) {
                log::warn!("could not focus main window: {e}");
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shared)
        .setup(move |app| {
            menubar::setup(app)?;
            notifications::setup(app.handle()).map_err(std::io::Error::other)?;
            if let Err(e) = spawn_daemon(app) {
                let state = app.state::<SharedState>();
                state.inner.lock().unwrap().error = Some(e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_connection,
            menubar::set_tray_count,
            menubar::menubar_hide,
            menubar::open_main,
            menubar::main_ready,
            menubar::quit_app,
            notifications::notifications_initialize,
            notifications::notifications_post,
            notifications::notifications_remove,
            notifications::notifications_take_actions,
            notifications::notifications_open
        ])
        .build(tauri::generate_context!())
        .expect("error while building Boto")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let state = app_handle.state::<SharedState>();
                let mut inner = state.inner.lock().unwrap();
                if let Some(child) = inner.child.take() {
                    if let Err(e) = child.kill() {
                        log::warn!("could not kill botod: {e}");
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{migrate_data_dir, parse_ready_port};

    #[test]
    fn migrates_legacy_data_without_overwriting_boto() {
        for identifier in ["com.upbot.desktop", "com.bobagent.desktop"] {
            let parent =
                std::env::temp_dir().join(format!("boto-migration-{}", rand::random::<u64>()));
            let legacy = parent.join(identifier);
            let current = parent.join("com.boto.desktop");
            std::fs::create_dir_all(&legacy).unwrap();
            std::fs::write(legacy.join("upbot.db"), b"preserved").unwrap();
            migrate_data_dir(&current).unwrap();
            assert!(!legacy.exists());
            assert_eq!(
                std::fs::read(current.join("upbot.db")).unwrap(),
                b"preserved"
            );
            std::fs::create_dir(&legacy).unwrap();
            std::fs::write(legacy.join("upbot.db"), b"other").unwrap();
            migrate_data_dir(&current).unwrap();
            assert_eq!(
                std::fs::read(current.join("upbot.db")).unwrap(),
                b"preserved"
            );
            assert_eq!(std::fs::read(legacy.join("upbot.db")).unwrap(), b"other");
            std::fs::remove_dir_all(parent).unwrap();
        }
    }

    #[test]
    fn parses_valid_ready_port() {
        assert_eq!(parse_ready_port(r#"{"port":4321}"#), Ok(4321));
    }

    #[test]
    fn rejects_invalid_ready_ports() {
        for json in [
            r#"{"port":0}"#,
            r#"{"port":70000}"#,
            "{}",
            r#"{"port":"1"}"#,
        ] {
            assert_eq!(parse_ready_port(json), Err("botod READY has no valid port"));
        }
    }

    #[test]
    fn rejects_invalid_ready_json() {
        assert_eq!(
            parse_ready_port("not json"),
            Err("botod READY line is not valid JSON")
        );
    }

    #[test]
    fn does_not_leak_ready_payloads_in_errors() {
        for json in [
            r#"{"port":0,"token":"sk-live-SECRET"}"#,
            "sk-live-SECRET not json",
        ] {
            let error = parse_ready_port(json).unwrap_err();
            assert!(!error.contains("SECRET"));
        }
    }
}
