use super::{xml, Notification};
use std::{collections::HashMap, ffi::c_void, sync::Mutex};
use tauri::{AppHandle, Manager};
use windows::{
    core::{implement, w, IUnknown, Interface, Ref, BOOL, GUID, HSTRING, PCWSTR},
    Data::Xml::Dom::XmlDocument,
    Win32::{
        Foundation::{CLASS_E_NOAGGREGATION, E_POINTER},
        System::Com::{
            CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, IClassFactory,
            IClassFactory_Impl, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, REGCLS_MULTIPLEUSE,
        },
        UI::{
            Notifications::{
                INotificationActivationCallback, INotificationActivationCallback_Impl,
                NOTIFICATION_USER_INPUT_DATA,
            },
            Shell::SetCurrentProcessExplicitAppUserModelID,
        },
    },
    UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier},
};

const AUMID: &str = "com.upbot.desktop";
const ACTIVATOR: GUID = GUID::from_u128(0x42dd1a5e_5b26_40be_97e7_286ec9f8582f);
const ACTIVATOR_ID: &str = "{42DD1A5E-5B26-40BE-97E7-286EC9F8582F}";

#[implement(INotificationActivationCallback)]
struct Activator {
    app: AppHandle,
}

impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(
        &self,
        app_id: &PCWSTR,
        args: &PCWSTR,
        _data: *const NOTIFICATION_USER_INPUT_DATA,
        _count: u32,
    ) -> windows::core::Result<()> {
        let app_id = unsafe { app_id.to_string()? };
        let args = unsafe { args.to_string()? };
        if app_id != AUMID {
            log::warn!("ignored toast activation for app id {app_id}");
            return Ok(());
        }
        match super::parse_activation(&args) {
            Some(response) => super::respond(&self.app, response.id, response.action),
            None => log::warn!("ignored unparseable toast activation"),
        }
        Ok(())
    }
}

#[implement(IClassFactory)]
struct Factory {
    app: AppHandle,
}

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        result: *mut *mut c_void,
    ) -> windows::core::Result<()> {
        if result.is_null() || iid.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe {
            *result = std::ptr::null_mut();
        }
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let callback: INotificationActivationCallback = Activator {
            app: self.app.clone(),
        }
        .into();
        unsafe { callback.query(iid, result).ok() }
    }
    fn LockServer(&self, _lock: BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}

pub struct WindowsNotifications {
    notifier: ToastNotifier,
    toasts: Mutex<HashMap<String, ToastNotification>>,
    registration: u32,
}

impl Drop for WindowsNotifications {
    fn drop(&mut self) {
        unsafe {
            let _ = CoRevokeClassObject(self.registration);
        }
    }
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
        .map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let app_key = windows_registry::CURRENT_USER
        .create(format!("Software\\Classes\\AppUserModelId\\{AUMID}"))
        .map_err(|error| error.to_string())?;
    app_key
        .set_string("DisplayName", "UpBot")
        .map_err(|error| error.to_string())?;
    app_key
        .set_string("CustomActivator", ACTIVATOR_ID)
        .map_err(|error| error.to_string())?;
    let server = windows_registry::CURRENT_USER
        .create(format!(
            "Software\\Classes\\CLSID\\{ACTIVATOR_ID}\\LocalServer32"
        ))
        .map_err(|error| error.to_string())?;
    server
        .set_string("", format!("\"{}\" -ToastActivated", executable.display()))
        .map_err(|error| error.to_string())?;
    unsafe { SetCurrentProcessExplicitAppUserModelID(w!("com.upbot.desktop")) }
        .map_err(|error| error.to_string())?;
    let factory: IClassFactory = Factory { app: app.clone() }.into();
    let registration = unsafe {
        CoRegisterClassObject(
            &ACTIVATOR,
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )
    }
    .map_err(|error| error.to_string())?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
        .map_err(|error| error.to_string())?;
    app.manage(WindowsNotifications {
        notifier,
        toasts: Mutex::new(HashMap::new()),
        registration,
    });
    Ok(())
}

pub fn post(app: &AppHandle, notification: Notification) -> Result<(), String> {
    let state = app
        .try_state::<WindowsNotifications>()
        .ok_or("As notificações do Windows não estão disponíveis.")?;
    let document = XmlDocument::new().map_err(|error| error.to_string())?;
    document
        .LoadXml(&HSTRING::from(xml::toast(&notification)))
        .map_err(|error| error.to_string())?;
    let toast =
        ToastNotification::CreateToastNotification(&document).map_err(|error| error.to_string())?;
    toast
        .SetTag(&HSTRING::from(xml::tag(&notification.id)))
        .map_err(|error| error.to_string())?;
    toast
        .SetGroup(&HSTRING::from("upbot"))
        .map_err(|error| error.to_string())?;
    toast
        .SetSuppressPopup(notification.muted)
        .map_err(|error| error.to_string())?;
    state
        .notifier
        .Show(&toast)
        .map_err(|error| error.to_string())?;
    state.toasts.lock().unwrap().insert(notification.id, toast);
    Ok(())
}

pub fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
    let Some(state) = app.try_state::<WindowsNotifications>() else {
        return Ok(());
    };
    if let Some(toast) = state.toasts.lock().unwrap().remove(id) {
        state
            .notifier
            .Hide(&toast)
            .map_err(|error| error.to_string())?;
    }
    ToastNotificationManager::History()
        .and_then(|history| {
            history.RemoveGroupedTagWithId(
                &HSTRING::from(xml::tag(id)),
                &HSTRING::from("upbot"),
                &HSTRING::from(AUMID),
            )
        })
        .map_err(|error| error.to_string())
}
