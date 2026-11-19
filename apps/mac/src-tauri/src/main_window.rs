/// Orka's URL scheme. Sign-in callbacks and join links share it.
const SCHEME: &str = "orka";

/// Whether an opened URL batch should bring this profile forward.
///
/// A sign-in callback belongs to the profile named in it. The frontend routes
/// it there, and that profile reveals itself when it takes the callback in
/// `profiles::profile_events`, so this profile stays put for another profile's
/// callback. Join links and invalid callbacks are handled here.
pub fn reveals_current(urls: &[tauri::Url], current: &str) -> bool {
    urls.iter().filter(|url| url.scheme() == SCHEME).any(|url| {
        url.host_str() != Some("auth")
            || crate::auth::callback_profile(url.as_str()).map_or(true, |owner| owner == current)
    })
}

/// Activates Orka so macOS switches to the Space holding its window.
#[cfg(target_os = "macos")]
pub fn activate() {
    use objc2_app_kit::NSApplication;
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
    };
    // Tauri's set_focus only activates a visible, non-minimized window, so
    // activate explicitly to leave another app's Space.
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
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
        let reveals = |raw: &[&str], current| super::reveals_current(&urls(raw), current);
        let join = "orka://join/token?server=https%3A%2F%2Forka.example";
        assert!(reveals(&[join], "default"));
        assert!(reveals(&[join], "alice"));
        // Sign-in callbacks reveal only the profile that requested them.
        assert!(reveals(&["orka://auth/callback?code=c"], "default"));
        assert!(!reveals(&["orka://auth/callback?code=c"], "alice"));
        assert!(reveals(&["orka://auth/callback?code=c&profile=bob"], "bob"));
        assert!(!reveals(
            &["orka://auth/callback?code=c&profile=bob"],
            "alice"
        ));
        // A malformed callback surfaces its error here, so it reveals here.
        assert!(reveals(&["orka://auth/other?code=c"], "alice"));
        assert!(reveals(
            &["orka://auth/callback?profile=bob&profile=alice"],
            "alice"
        ));
        // Mixed batches reveal when any link belongs here.
        assert!(reveals(
            &["orka://auth/callback?code=c&profile=bob", join],
            "alice"
        ));
        assert!(!reveals(&[], "default"));
        assert!(!reveals(
            &["https://orka.example/join/token", "http://orka.example/"],
            "default"
        ));
    }
}
