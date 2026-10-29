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

const READY_PREFIX: &str = "UPBOT_READY ";

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

fn spawn_daemon(app: &tauri::App) -> Result<(), String> {
    let state: SharedState = app.state::<SharedState>().inner().clone();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    if !data_dir.exists() {
        if let Some(legacy) = data_dir.parent().map(|p| p.join("com.bobagent.desktop")) {
            if legacy.is_dir() {
                if let Err(e) = std::fs::rename(&legacy, &data_dir) {
                    log::warn!("could not migrate legacy BobAgent data dir: {e}");
                }
            }
        }
    }
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create data dir: {e}"))?;
    let token = hex_token();

    let sidecar = app
        .shell()
        .sidecar("upbotd")
        .map_err(|e| format!("sidecar: {e}"))?;
    let (mut rx, mut child) = sidecar
        .args([OsStr::new("--data-dir"), data_dir.as_os_str()])
        .spawn()
        .map_err(|e| format!("spawn upbotd: {e}"))?;
    // deliver the auth token on the daemon's first stdin line
    child
        .write(format!("{token}\n").as_bytes())
        .map_err(|e| format!("write token to upbotd stdin: {e}"))?;

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
                            match serde_json::from_str::<serde_json::Value>(json) {
                                Ok(v) => {
                                    let port = v["port"].as_u64().unwrap_or(0) as u16;
                                    {
                                        let mut inner = state.inner.lock().unwrap();
                                        inner.conn = Some(DaemonConnection {
                                            port,
                                            token: token.clone(),
                                        });
                                    }
                                    state.ready.notify_waiters();
                                }
                                Err(e) => log::error!("bad READY line from upbotd: {e}"),
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        log::info!("upbotd: {line}");
                    }
                }
                CommandEvent::Error(e) => log::error!("upbotd error: {e}"),
                CommandEvent::Terminated(status) => {
                    log::warn!("upbotd terminated: {status:?}");
                    {
                        let mut inner = state.inner.lock().unwrap();
                        if inner.conn.is_none() && inner.error.is_none() {
                            inner.error = Some(format!("upbotd exited: {status:?}"));
                        }
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
        .expect("error while building UpBot")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let state = app_handle.state::<SharedState>();
                let mut inner = state.inner.lock().unwrap();
                if let Some(child) = inner.child.take() {
                    if let Err(e) = child.kill() {
                        log::warn!("could not kill upbotd: {e}");
                    }
                }
            }
        });
}
