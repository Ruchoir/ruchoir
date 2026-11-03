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

/// Like `navigation`, with the origins the app has agreed to frame (`https://host[:port]`, compared
/// exactly: no suffix, no wildcard). A navigation to one of them stays, which is how the office
/// editor's frame loads; anything else is decided by `navigation`.
pub fn navigation_allowing(url: &url::Url, frames: &[String]) -> Navigation {
    if url.scheme() == "https"
        && frames
            .iter()
            .any(|o| *o == url.origin().ascii_serialization())
    {
        return Navigation::Stay;
    }
    navigation(url)
}

/// The normalized origin of an origin the interface asks to frame: `https`, a host, an optional
/// port, and nothing else (no path, query, fragment or user information).
pub fn frame_origin(input: &str) -> Option<String> {
    let url = url::Url::parse(input).ok()?;
    let plain = url.scheme() == "https"
        && url.host_str().is_some_and(|h| !h.is_empty())
        && url.path() == "/"
        && !input.contains('?')
        && !input.contains('#')
        && url.username().is_empty()
        && url.password().is_none();
    plain.then(|| url.origin().ascii_serialization())
}

/// The origins allowed to be framed: the newest few, the oldest dropped to make room.
#[derive(Debug, Default)]
pub struct FrameList {
    origins: Vec<String>,
}

impl FrameList {
    /// The most origins kept: an instance has one office host.
    pub const MAX: usize = 8;

    /// Allow an origin (already normalized by `frame_origin`); a known one is not repeated.
    pub fn allow(&mut self, origin: String) {
        if self.origins.contains(&origin) {
            return;
        }
        if self.origins.len() >= Self::MAX {
            self.origins.remove(0);
        }
        self.origins.push(origin);
    }

    /// Forget them all (an instance was removed or signed out).
    pub fn clear(&mut self) {
        self.origins.clear();
    }

    pub fn origins(&self) -> &[String] {
        &self.origins
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

    #[test]
    fn an_allowed_frame_origin_stays() {
        let frames = vec!["https://office-ruchoir-dev.theovilain.fr".to_owned()];
        let at = |u: &str| navigation_allowing(&url::Url::parse(u).unwrap(), &frames);
        assert_eq!(
            at("https://office-ruchoir-dev.theovilain.fr/hosting/wopi/word/edit?x=1"),
            Navigation::Stay
        );
        assert_eq!(
            at("https://office-ruchoir-dev.theovilain.fr.evil.org/"),
            Navigation::OpenOutside
        );
        assert_eq!(
            at("https://evil.org/?https://office-ruchoir-dev.theovilain.fr"),
            Navigation::OpenOutside
        );
        assert_eq!(at("https://example.org/"), Navigation::OpenOutside);
        assert_eq!(
            at("http://office-ruchoir-dev.theovilain.fr/"),
            Navigation::OpenOutside
        );
        assert_eq!(
            at("https://office-ruchoir-dev.theovilain.fr:8443/"),
            Navigation::OpenOutside
        );
    }

    #[test]
    fn no_allowed_origin_behaves_like_navigation() {
        for u in [
            "https://example.org/",
            "ruchoir-app://localhost/",
            "file:///etc/passwd",
        ] {
            let url = url::Url::parse(u).unwrap();
            assert_eq!(navigation_allowing(&url, &[]), navigation(&url));
        }
    }

    fn allowed(url: &str) -> Navigation {
        let frames = vec!["https://office.example.org".to_owned()];
        navigation_allowing(&url::Url::parse(url).unwrap(), &frames)
    }

    #[test]
    fn an_uppercase_host_is_normalized_and_stays() {
        assert_eq!(allowed("https://OFFICE.Example.org/x"), Navigation::Stay);
    }

    #[test]
    fn userinfo_does_not_change_the_origin_so_the_allowed_host_stays() {
        // The origin of `https://x@office.example.org/` is the allowed host: the request goes there.
        assert_eq!(allowed("https://x@office.example.org/"), Navigation::Stay);
        assert_eq!(
            allowed("https://office.example.org@evil.org/"),
            Navigation::OpenOutside
        );
    }

    #[test]
    fn a_trailing_dot_host_does_not_stay() {
        assert_eq!(
            allowed("https://office.example.org./"),
            Navigation::OpenOutside
        );
    }

    #[test]
    fn an_idn_host_stays_when_its_punycode_form_was_allowed() {
        let frames = vec!["https://xn--bcher-kva.example".to_owned()];
        let url = url::Url::parse("https://bücher.example/").unwrap();
        assert_eq!(navigation_allowing(&url, &frames), Navigation::Stay);
    }

    #[test]
    fn frame_origin_accepts_plain_https_origins() {
        assert_eq!(
            frame_origin("https://office.example.org").as_deref(),
            Some("https://office.example.org")
        );
        assert_eq!(
            frame_origin("https://office.example.org:8443").as_deref(),
            Some("https://office.example.org:8443")
        );
        assert_eq!(
            frame_origin("https://OFFICE.example.org/").as_deref(),
            Some("https://office.example.org")
        );
    }

    #[test]
    fn frame_origin_refuses_anything_else() {
        for input in [
            "http://office.example.org",
            "https://office.example.org/path",
            "https://office.example.org?x=1",
            "https://office.example.org/?x=1",
            "https://office.example.org#frag",
            "https://user@office.example.org",
            "https://user:pw@office.example.org",
            "https://",
            "not a url",
            "",
        ] {
            assert_eq!(frame_origin(input), None, "{input}");
        }
    }

    #[test]
    fn the_frame_list_keeps_the_newest_and_clears() {
        let mut list = FrameList::default();
        for i in 0..FrameList::MAX + 2 {
            list.allow(format!("https://h{i}.example"));
        }
        list.allow("https://h9.example".to_owned());
        assert_eq!(list.origins().len(), FrameList::MAX);
        assert_eq!(
            list.origins().first().map(String::as_str),
            Some("https://h2.example")
        );
        assert_eq!(
            list.origins().last().map(String::as_str),
            Some("https://h9.example")
        );
        list.clear();
        assert!(list.origins().is_empty());
    }
}
