use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
#[path = "notifications_macos.rs"]
mod platform;

#[cfg(target_os = "windows")]
#[path = "notifications_windows.rs"]
mod platform;

#[cfg(any(target_os = "windows", test))]
#[path = "notifications_xml.rs"]
mod xml;

#[derive(Clone, Deserialize)]
pub struct NotificationButton {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Deserialize)]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub actions: Vec<NotificationButton>,
    pub muted: bool,
}

#[derive(Clone, Serialize)]
pub struct NotificationResponse {
    pub id: String,
    pub action: String,
}

#[derive(Default)]
pub struct NotificationState {
    actions: Mutex<Vec<NotificationResponse>>,
    error: Mutex<Option<String>>,
}

pub type Completion<T> = Box<dyn FnOnce(Result<T, String>) + Send>;

pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.manage(NotificationState::default());
    #[cfg(target_os = "macos")]
    platform::setup(app);
    #[cfg(target_os = "windows")]
    if let Err(error) = platform::setup(app) {
        log::warn!("Native notification setup: {error}");
        *app.state::<NotificationState>().error.lock().unwrap() = Some(error);
    }
    Ok(())
}

pub fn respond(app: &AppHandle, id: String, action: String) {
    app.state::<NotificationState>()
        .actions
        .lock()
        .unwrap()
        .push(NotificationResponse { id, action });
    let _ = app.emit_to("main", "upbot://notification-actions", ());
}

async fn on_main<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(Completion<T>) + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        work(Box::new(move |result| {
            let _ = sender.send(result);
        }))
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn notifications_initialize(app: AppHandle) -> Result<bool, String> {
    if let Some(error) = app
        .state::<NotificationState>()
        .error
        .lock()
        .unwrap()
        .clone()
    {
        return Err(error);
    }
    #[cfg(target_os = "windows")]
    let native_app = app.clone();
    on_main(app, move |done| {
        #[cfg(target_os = "macos")]
        platform::initialize(done);
        #[cfg(target_os = "windows")]
        done(Ok(native_app
            .try_state::<platform::WindowsNotifications>()
            .is_some()));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        done(Ok(false));
    })
    .await
}

#[tauri::command]
pub async fn notifications_post(app: AppHandle, notification: Notification) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let native_app = app.clone();
    on_main(app, move |done| {
        #[cfg(target_os = "macos")]
        platform::post(notification, done);
        #[cfg(target_os = "windows")]
        done(platform::post(&native_app, notification));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = notification;
            done(Ok(()));
        }
    })
    .await
}

#[tauri::command]
pub async fn notifications_remove(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let native_app = app.clone();
    on_main(app, move |done| {
        #[cfg(target_os = "macos")]
        platform::remove(&id);
        #[cfg(target_os = "windows")]
        {
            done(platform::remove(&native_app, &id));
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let _ = id;
        #[cfg(not(target_os = "windows"))]
        done(Ok(()));
    })
    .await
}

#[tauri::command]
pub fn notifications_take_actions(
    state: State<'_, NotificationState>,
) -> Vec<NotificationResponse> {
    std::mem::take(&mut *state.actions.lock().unwrap())
}

#[tauri::command]
pub fn notifications_open(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("A janela do UpBot não está disponível.")?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}
