/// Orka's URL scheme. Sign-in callbacks and join links share it.
const SCHEME: &str = "orka";

/// Routes foreign callbacks even when the receiving WebView is suspended.
/// Returns whether any remaining Orka link should reveal this profile.
pub fn route_opened(urls: &[tauri::Url], current: &str) -> bool {
    let mut reveal = false;
    for url in urls.iter().filter(|url| url.scheme() == SCHEME) {
        match crate::auth::callback_profile(url.as_str()) {
            Ok(owner) if owner != current => {
                if let Err(error) =
                    crate::profiles::route_foreign_auth_callback(owner, url.as_str())
                {
                    eprintln!("Orka could not route sign-in callback: {error}");
                }
            }
            _ => reveal = true,
        }
    }
    reveal
}

#[cfg(test)]
mod tests {
    fn urls(raw: &[&str]) -> Vec<tauri::Url> {
        raw.iter()
            .map(|url| url.parse().expect("Test URL"))
            .collect()
    }

    #[test]
    fn only_links_this_profile_consumes_reveal_it() {
        let reveals = |raw: &[&str], current| super::route_opened(&urls(raw), current);
        let join = "orka://join/token?server=https%3A%2F%2Forka.example";
        assert!(reveals(&[join], "default"));
        assert!(reveals(&[join], "alice"));
        // Sign-in callbacks reveal only the profile that requested them.
        assert!(reveals(&["orka://auth/callback?code=c"], "default"));
        assert!(reveals(&["orka://auth/callback?code=c&profile=bob"], "bob"));
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
