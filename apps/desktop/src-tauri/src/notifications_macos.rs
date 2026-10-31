use super::{Completion, Notification};
use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationDismissActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tauri::AppHandle;

define_class!(
    #[unsafe(super = NSObject)]
    #[ivars = AppHandle]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn received(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let identifier = response.actionIdentifier();
            if !identifier.isEqualToString(unsafe { UNNotificationDismissActionIdentifier }) {
                let action = if identifier
                    .isEqualToString(unsafe { UNNotificationDefaultActionIdentifier })
                {
                    "review".to_string()
                } else {
                    identifier.to_string()
                };
                super::respond(
                    self.ivars(),
                    response.notification().request().identifier().to_string(),
                    action,
                );
            }
            completion.call(());
        }
    }
);

thread_local! {
    static DELEGATE: RefCell<Option<Retained<NotificationDelegate>>> = const { RefCell::new(None) };
    static CATEGORIES: RefCell<BTreeMap<String, Retained<UNNotificationCategory>>> = const { RefCell::new(BTreeMap::new()) };
}

fn bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle
        .bundleIdentifier()
        .is_some_and(|id| id.to_string() == "com.boto.desktop")
        && bundle.bundlePath().to_string().ends_with(".app")
}

pub fn setup(app: &AppHandle) {
    if !bundled() {
        log::info!("Native notifications disabled for the unbundled development binary");
        return;
    }
    let delegate: Retained<NotificationDelegate> = unsafe {
        let this = NotificationDelegate::alloc().set_ivars(app.clone());
        msg_send![super(this), init]
    };
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    DELEGATE.with(|value| value.replace(Some(delegate)));
}

pub fn initialize(done: Completion<bool>) {
    if !bundled() {
        done(Ok(false));
        return;
    }
    let done = Arc::new(Mutex::new(Some(done)));
    let callback = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if let Some(done) = done.lock().unwrap().take() {
            let result = if error.is_null() {
                Ok(granted.as_bool())
            } else {
                Err(unsafe { &*error }.localizedDescription().to_string())
            };
            done(result);
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &callback,
        );
}

pub fn post(notification: Notification, done: Completion<()>) {
    if !bundled() {
        done(Ok(()));
        return;
    }
    if notification.muted {
        remove(&notification.id);
        done(Ok(()));
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let actions: Vec<_> = notification
        .actions
        .iter()
        .map(|action| {
            let options = if action.id == "review" {
                UNNotificationActionOptions::Foreground
            } else {
                UNNotificationActionOptions::AuthenticationRequired
            };
            UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(&action.id),
                &NSString::from_str(&action.label),
                options,
            )
        })
        .collect();
    let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(&notification.id),
        &NSArray::from_retained_slice(&actions),
        &NSArray::new(),
        UNNotificationCategoryOptions::empty(),
    );
    CATEGORIES.with(|categories| {
        let mut categories = categories.borrow_mut();
        categories.insert(notification.id.clone(), category);
        center.setNotificationCategories(&NSSet::from_retained_slice(
            &categories.values().cloned().collect::<Vec<_>>(),
        ));
    });
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notification.title));
    content.setBody(&NSString::from_str(&notification.body));
    content.setCategoryIdentifier(&NSString::from_str(&notification.id));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&notification.id),
        &content,
        None,
    );
    let done = Arc::new(Mutex::new(Some(done)));
    let callback = RcBlock::new(move |error: *mut NSError| {
        if let Some(done) = done.lock().unwrap().take() {
            done(if error.is_null() {
                Ok(())
            } else {
                Err(unsafe { &*error }.localizedDescription().to_string())
            });
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&callback));
}

pub fn remove(id: &str) {
    if !bundled() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let ids = NSArray::from_retained_slice(&[NSString::from_str(id)]);
    center.removePendingNotificationRequestsWithIdentifiers(&ids);
    center.removeDeliveredNotificationsWithIdentifiers(&ids);
    CATEGORIES.with(|categories| {
        let mut categories = categories.borrow_mut();
        categories.remove(id);
        center.setNotificationCategories(&NSSet::from_retained_slice(
            &categories.values().cloned().collect::<Vec<_>>(),
        ));
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn bare_test_binary_never_uses_user_notification_center() {
        assert!(!super::bundled());
        super::initialize(Box::new(|result| assert_eq!(result, Ok(false))));
    }
}
