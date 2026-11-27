/// Orka's URL scheme. Sign-in callbacks and join links share it.
#[allow(dead_code)]
const SCHEME: &str = "orka";

/// Routes sign-in callbacks independently of any webview. Returns whether to
/// reveal the receiving profile and the first routing error in this batch.
pub fn route_opened(urls: &[tauri::Url], current: &str) -> (bool, Option<String>) {
    let mut reveal = false;
    let mut routing_error = None;
    for url in urls.iter().filter(|url| url.scheme() == SCHEME) {
        match crate::auth::callback_profile(url.as_str()) {
            Ok(owner) => {
                if let Err(error) =
                    crate::profiles::deliver_auth_callback(&owner, url.as_str(), current)
                {
                    routing_error.get_or_insert(error);
                    reveal = true;
                } else {
                    reveal |= owner == current;
                }
            }
            Err(_) => reveal = true,
        }
    }
    (reveal, routing_error)
}

#[cfg(test)]
mod tests {
    fn urls(raw: &[&str]) -> Vec<tauri::Url> {
        raw.iter()
            .map(|url| url.parse().expect("Test URL"))
            .collect()
    }

    #[test]
    fn only_orka_links_can_reveal_this_profile() {
        let reveals = |raw: &[&str], current| super::route_opened(&urls(raw), current).0;
        let join = "orka://join/token?server=https%3A%2F%2Forka.example";
        assert!(reveals(&[join], "default"));
        assert!(reveals(&[join], "alice"));
        // A malformed callback surfaces its error here, so it reveals here.
        assert!(reveals(&["orka://auth/other?code=c"], "alice"));
        assert!(reveals(
            &["orka://auth/callback?profile=bob&profile=alice"],
            "alice"
        ));
        assert!(!reveals(&[], "default"));
        assert!(!reveals(
            &["https://orka.example/join/token", "http://orka.example/"],
            "default"
        ));
    }
}
