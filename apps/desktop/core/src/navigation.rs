//! Where the window may go. It shows the app's own origin and nothing else: a link to another site
//! opens in the system browser, and the window never leaves Ruchoir (a remote page in it would sit
//! where the interface was, under the app's name).

/// What to do with a navigation of the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    /// The app's own origin (or a blank or blob page it made): go there.
    Stay,
    /// A web page or a mail address: hand it to the system, stay put.
    OpenOutside,
    /// Anything else (files, scripts, other schemes): do nothing.
    Refuse,
}

/// Decide a navigation of the window.
pub fn navigation(url: &url::Url) -> Navigation {
    match url.scheme() {
        "ruchoir-app" if url.host_str() == Some("localhost") => Navigation::Stay,
        // Windows spells the app's protocol `http://ruchoir-app.localhost/`.
        "http" if url.host_str() == Some("ruchoir-app.localhost") => Navigation::Stay,
        "about" if url.path() == "blank" => Navigation::Stay,
        "blob" => Navigation::Stay,
        "http" | "https" | "mailto" => Navigation::OpenOutside,
        _ => Navigation::Refuse,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(url: &str) -> Navigation {
        navigation(&url::Url::parse(url).unwrap())
    }

    #[test]
    fn the_app_origin_stays() {
        assert_eq!(
            at("ruchoir-app://localhost/e/s/c/general"),
            Navigation::Stay
        );
        assert_eq!(
            at("http://ruchoir-app.localhost/e/s/c/general"),
            Navigation::Stay
        );
        assert_eq!(at("about:blank"), Navigation::Stay);
        assert_eq!(at("blob:ruchoir-app://localhost/1234"), Navigation::Stay);
    }

    #[test]
    fn other_sites_open_in_the_browser() {
        assert_eq!(at("https://example.org/page"), Navigation::OpenOutside);
        assert_eq!(at("http://example.org/"), Navigation::OpenOutside);
        assert_eq!(at("mailto:alice@example.org"), Navigation::OpenOutside);
        assert_eq!(
            at("http://ruchoir-app.localhost.evil.example/"),
            Navigation::OpenOutside
        );
        assert_eq!(at("ruchoir-app://elsewhere/"), Navigation::Refuse);
    }

    #[test]
    fn anything_else_is_refused() {
        assert_eq!(at("file:///etc/passwd"), Navigation::Refuse);
        assert_eq!(at("javascript:alert(1)"), Navigation::Refuse);
        assert_eq!(at("ruchoir://auth?code=x"), Navigation::Refuse);
    }
}
