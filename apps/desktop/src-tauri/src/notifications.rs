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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NotificationResponse {
    pub id: String,
    pub action: String,
}

#[derive(Default)]
pub struct NotificationState {
    actions: Mutex<Vec<NotificationResponse>>,
    error: Mutex<Option<String>>,
}

pub fn parse_activation(payload: &str) -> Option<NotificationResponse> {
    let (action, id) = payload.split_once('|')?;
    if !matches!(
        action,
        "approve" | "task" | "deny" | "review" | "undo" | "mute" | "apps"
    ) || id.contains('|')
        || id.chars().any(char::is_control)
        || (id.is_empty() && !matches!(action, "mute" | "apps"))
    {
        return None;
    }
    Some(NotificationResponse {
        id: id.to_string(),
        action: action.to_string(),
    })
}

fn launch_activation(args: &[String]) -> Option<NotificationResponse> {
    for (index, arg) in args.iter().enumerate().skip(1) {
        let (flag, value) = arg.split_once('=').unwrap_or((arg, ""));
        if flag.eq_ignore_ascii_case("-ToastActivated") {
            // The Windows single-instance transport separates arguments on pipes.
            let rest = args[index + 1..].join("|");
            let payload = if value.is_empty() {
                rest
            } else if rest.is_empty() {
                value.to_string()
            } else {
                format!("{value}|{rest}")
            };
            return parse_activation(&payload);
        }
    }
    None
}

impl NotificationState {
    pub fn from_args(args: &[String]) -> Self {
        let state = Self::default();
        if let Some(response) = launch_activation(args) {
            state.enqueue(response);
        }
        state
    }

    fn enqueue(&self, response: NotificationResponse) {
        let mut actions = self.actions.lock().unwrap();
        if !actions.contains(&response) {
            actions.push(response);
        }
    }

    fn take_actions(&self) -> Vec<NotificationResponse> {
        std::mem::take(&mut *self.actions.lock().unwrap())
    }
}

pub fn forward_launch(app: &AppHandle, args: &[String]) {
    if let Some(response) = launch_activation(args) {
        respond(app, response.id, response.action);
    }
}

pub type Completion<T> = Box<dyn FnOnce(Result<T, String>) + Send>;

pub fn setup(app: &AppHandle) -> Result<(), String> {
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
        .enqueue(NotificationResponse { id, action });
    let _ = app.emit_to("main", "boto://notification-actions", ());
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
    let id = notification.id.clone();
    let result = on_main(app, move |done| {
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
    .await;
    if let Err(error) = &result {
        log::warn!("could not post notification {id}: {error}");
    }
    result
}

#[tauri::command]
pub async fn notifications_remove(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let native_app = app.clone();
    let log_id = id.clone();
    let result = on_main(app, move |done| {
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
    .await;
    if let Err(error) = &result {
        log::warn!("could not remove notification {log_id}: {error}");
    }
    result
}

#[tauri::command]
pub fn notifications_take_actions(
    state: State<'_, NotificationState>,
) -> Vec<NotificationResponse> {
    state.take_actions()
}

#[tauri::command]
pub fn notifications_open(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("A janela do Boto não está disponível.")?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn startup_and_forwarded_activation_arguments() {
        let expected = Some(NotificationResponse {
            id: "approval-id".into(),
            action: "task".into(),
        });
        for values in [
            vec!["Boto.exe", "-ToastActivated", "task|approval-id"],
            vec!["Boto.exe", "-toastactivated=task|approval-id"],
            vec!["Boto.exe", "-ToastActivated", "task", "approval-id"],
            vec!["Boto.exe", "-ToastActivated=task", "approval-id"],
        ] {
            assert_eq!(launch_activation(&args(&values)), expected);
        }
    }

    #[test]
    fn invalid_or_payload_free_launch_waits_for_com() {
        for values in [
            vec!["Boto.exe"],
            vec!["Boto.exe", "task|approval-id"],
            vec!["Boto.exe", "-ToastActivated"],
            vec!["Boto.exe", "-ToastActivated", "always|approval-id"],
            vec!["Boto.exe", "-ToastActivated", "task|"],
            vec!["Boto.exe", "-ToastActivated", "task|id|extra"],
            vec!["Boto.exe", "-ToastActivated", "task|id\n"],
        ] {
            assert!(launch_activation(&args(&values)).is_none());
            assert!(NotificationState::from_args(&args(&values))
                .take_actions()
                .is_empty());
        }
    }

    #[test]
    fn startup_queue_survives_until_drain_and_deduplicates_com_response() {
        let state =
            NotificationState::from_args(&args(&["Boto.exe", "-ToastActivated", "task|id"]));
        assert_eq!(
            state.actions.lock().unwrap().as_slice(),
            &[NotificationResponse {
                id: "id".into(),
                action: "task".into(),
            }]
        );
        state.enqueue(parse_activation("task|id").unwrap());
        assert_eq!(
            state.take_actions(),
            vec![parse_activation("task|id").unwrap()]
        );
        assert!(state.take_actions().is_empty());
        state.enqueue(parse_activation("review|next").unwrap());
        assert_eq!(
            state.take_actions(),
            vec![parse_activation("review|next").unwrap()]
        );
    }
}
