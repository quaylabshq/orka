use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::LazyLock;

pub(crate) struct SessionRedactor;

static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z0-9])(?:api[_ -]?key|token|secret|password|private[_ -]?key)(?:$|[^a-z0-9])").unwrap()
});
static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|",
        r"AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|",
        r"[sr]k_live_[A-Za-z0-9]{16,})"
    ))
    .unwrap()
});
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(Bearer[ \t]+)[A-Za-z0-9._~+/-]+=*").unwrap());
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----").unwrap()
});
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^([ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*[=:][ \t]*)[^\r\n]+")
        .unwrap()
});
static JSON_STRING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:(("(?:\\[^\r\n]|[^"\\\r\n])*")\s*:\s*))?("(?:\\[^\r\n]|[^"\\\r\n])*")"#)
        .unwrap()
});

impl SessionRedactor {
    pub(crate) fn check_upload(bytes: &[u8]) -> crate::db::Result<()> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| "422: Session upload blocked because the snapshot is not UTF-8")?;
        if text != Self::text(text) {
            return Err("422: Session upload blocked because the snapshot still contains a recognized secret".into());
        }
        Ok(())
    }

    pub(crate) fn redact(value: &mut Value) {
        match value {
            Value::String(text) => *text = Self::text(text),
            Value::Array(values) => values.iter_mut().for_each(Self::redact),
            Value::Object(fields) => {
                for (key, value) in fields {
                    if value.is_string() && SECRET_NAME.is_match(key) {
                        *value = Value::String("[REDACTED]".into());
                    } else {
                        Self::redact(value);
                    }
                }
            }
            _ => (),
        }
    }

    pub(crate) fn text(text: &str) -> String {
        // Walk JSON string tokens without collapsing duplicate fields or parsing
        // numeric values. Only re-encode strings whose contents actually change.
        let text = JSON_STRING.replace_all(text, |c: &Captures<'_>| {
            let Ok(value) = serde_json::from_str::<String>(&c[3]) else {
                return c[0].to_owned();
            };
            let secret = c
                .get(2)
                .and_then(|key| serde_json::from_str::<String>(key.as_str()).ok())
                .is_some_and(|key| SECRET_NAME.is_match(&key));
            let redacted = if secret {
                "[REDACTED]".into()
            } else {
                Self::text(&value)
            };
            if redacted == value {
                c[0].to_owned()
            } else {
                format!(
                    "{}{}",
                    c.get(1).map_or("", |prefix| prefix.as_str()),
                    serde_json::to_string(&redacted).unwrap()
                )
            }
        });
        let text = PRIVATE_KEY.replace_all(&text, "[REDACTED]");
        let text = ASSIGNMENT.replace_all(&text, |c: &Captures<'_>| {
            if SECRET_NAME.is_match(&c[2]) {
                format!("{}[REDACTED]", &c[1])
            } else {
                c[0].to_owned()
            }
        });
        let text = CREDENTIAL.replace_all(&text, "[REDACTED]");
        BEARER.replace_all(&text, "${1}[REDACTED]").into_owned()
    }
}
