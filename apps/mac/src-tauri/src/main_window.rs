/// Orka's URL scheme. Sign-in callbacks and join links share it.
const SCHEME: &str = "orka";

/// Whether an opened URL batch carries an Orka deep link.
pub fn has_deep_link(urls: &[tauri::Url]) -> bool {
    urls.iter().any(|url| url.scheme() == SCHEME)
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
    fn only_orka_urls_are_deep_links() {
        assert!(super::has_deep_link(&urls(&[
            "orka://join/token?server=https%3A%2F%2Forka.example"
        ])));
        assert!(super::has_deep_link(&urls(&[
            "orka://auth/callback?code=c"
        ])));
        assert!(super::has_deep_link(&urls(&[
            "https://example.com/",
            "orka://project/abc",
        ])));
        assert!(!super::has_deep_link(&urls(&[])));
        assert!(!super::has_deep_link(&urls(&[
            "https://orka.example/join/token",
            "http://orka.example/",
        ])));
    }
}
