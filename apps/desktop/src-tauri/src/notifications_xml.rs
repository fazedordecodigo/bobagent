use super::Notification;

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn tag(id: &str) -> String {
    let hash = id
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("{hash:016x}")
}

pub fn toast(notification: &Notification) -> String {
    let id = escape(&notification.id);
    let scenario = if notification
        .actions
        .iter()
        .any(|action| action.id != "undo")
    {
        " scenario=\"reminder\""
    } else {
        ""
    };
    let buttons = notification
        .actions
        .iter()
        .map(|action| {
            format!(
                "<action content=\"{}\" arguments=\"{}|{}\" activationType=\"foreground\"/>",
                escape(&action.label),
                escape(&action.id),
                id
            )
        })
        .collect::<String>();
    format!("<toast launch=\"review|{id}\"{scenario}><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><actions>{buttons}<action placement=\"contextMenu\" content=\"Silenciar o Boto por 1 hora\" arguments=\"mute|{id}\" activationType=\"foreground\"/><action placement=\"contextMenu\" content=\"Abrir Apps conectados\" arguments=\"apps|{id}\" activationType=\"foreground\"/></actions>{}</toast>",
        escape(&notification.title), escape(&notification.body), if notification.muted { "<audio silent=\"true\"/>" } else { "" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::NotificationButton;

    #[test]
    fn xml_escapes_payload_and_exposes_only_requested_actions_and_context_menu() {
        let xml = toast(&Notification {
            id: "id<&".into(),
            title: "A & B".into(),
            body: "<Anexo>".into(),
            muted: true,
            actions: vec![NotificationButton {
                id: "task".into(),
                label: "Só nesta tarefa".into(),
            }],
        });
        assert!(xml.contains("scenario=\"reminder\""));
        assert!(xml.contains("A &amp; B"));
        assert!(xml.contains("&lt;Anexo&gt;"));
        assert!(xml.contains("arguments=\"task|id&lt;&amp;\""));
        assert!(xml.contains("placement=\"contextMenu\""));
        assert!(xml.contains("<audio silent=\"true\"/>"));
        assert!(!xml.contains("Sempre"));
    }

    #[test]
    fn result_is_not_a_reminder_and_tags_are_stable_and_at_most_sixteen_characters() {
        let xml = toast(&Notification {
            id: "one".into(),
            title: "Concluído.".into(),
            body: String::new(),
            muted: false,
            actions: vec![],
        });
        assert!(!xml.contains("scenario="));
        assert!(!xml.contains("silent="));
        assert_eq!(tag("decision"), tag("decision"));
        assert_eq!(tag("long-decision-id".repeat(20).as_str()).len(), 16);
        assert_ne!(tag("one"), tag("two"));
    }
}
