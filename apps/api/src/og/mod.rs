//! Link preview cards: what a chat app shows when an address of this instance is pasted into it.
//!
//! Two halves. The page half runs when the app shell is served for a navigation: it looks at the
//! path and adds Open Graph and Twitter tags to the HTML, naming the card that fits the link (an
//! invitation, a conversation, a personal email link...). The image half answers those cards, as
//! PNG drawn from SVG templates (see `render`).
//!
//! Scrapers are not signed in, and whatever a card says is readable by anyone holding the link, so
//! a card never says more than the link itself does: a conversation or a space is a locked,
//! anonymous card, and only a *valid* invitation names its space and who sent it, which is exactly
//! what its own screen shows before sign-in. Everything is in the instance's language
//! (`RUCHOIR_DEFAULT_LOCALE`), since a scraper says nothing about its reader. The design and its
//! trade-offs are in `docs/adr/0002-link-preview-cards.md`.

pub mod render;
mod text;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::auth::mail_text::Locale;
use crate::state::AppState;
use render::Card;

/// The card image routes. Unauthenticated, like the page that points at them.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/og/invite/{token}", get(invite_image))
        .route("/api/v1/og/{name}", get(card_image))
}

/// Whether `req` is a browser (or scraper) asking for a page, rather than for a file or the API.
///
/// A scraper often sends no `Accept`, or `*/*`, where a browser sends `text/html`; both are pages as
/// long as the path looks like one of the app's (no extension, not under an API or asset prefix).
/// Anything else keeps going to the static files, with their truthful `404`.
pub fn is_page_request(req: &Request) -> bool {
    if req.method() != Method::GET {
        return false;
    }
    let path = req.uri().path();
    if ["/api/", "/_next/", "/emoji/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
    {
        return false;
    }
    let last = path.rsplit('/').next().unwrap_or("");
    if last.contains('.') {
        return false;
    }
    match req
        .headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
    {
        None => true,
        Some(accept) => accept.contains("text/html") || accept.contains("*/*"),
    }
}

/// Serve the page for a navigation, with the preview tags that fit its path. Replaces what
/// `ServeDir` did for pages: the app shell for a client route, an exported folder's own page, and
/// the redirect that adds a folder's slash.
pub async fn page(state: AppState, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or("").to_owned();
    let file = page_file(&state.config.web_dist, &path);
    // An exported folder is addressed with its slash, as the file server always redirected it: the
    // page's relative links are resolved against it.
    if file != state.config.web_dist.join("index.html") && !path.ends_with('/') {
        let target = if query.is_empty() {
            format!("{path}/")
        } else {
            format!("{path}/?{query}")
        };
        return axum::response::Redirect::permanent(&target).into_response();
    }
    let Ok(html) = tokio::fs::read_to_string(file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let tags = tags(&preview_for(&state, &path, &query).await, &state, &path);
    let html = match html.find("</head>") {
        Some(at) => format!("{}{tags}{}", &html[..at], &html[at..]),
        None => html,
    };
    let mut response = html.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    // The shell is revalidated on every load (see `http::router`), and so are the tags in it.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// The file a page path is served from: a folder of the export that has its own `index.html`
/// (`/status/`, `/docs/`) is that page, and every other path is the single-page app's shell. Only
/// plain segments are looked up, so `..` cannot walk out of the bundle.
fn page_file(web_dist: &std::path::Path, path: &str) -> std::path::PathBuf {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let plain = segments
        .iter()
        .all(|s| *s != "." && *s != ".." && !s.contains('\\'));
    if plain && !segments.is_empty() {
        let own = segments
            .iter()
            .fold(web_dist.to_path_buf(), |dir, s| dir.join(s))
            .join("index.html");
        if own.is_file() {
            return own;
        }
    }
    web_dist.join("index.html")
}

/// What the tags of one page say.
struct Preview {
    title: String,
    description: String,
    /// Path of the card image, under `/api/v1/og/`.
    image: String,
    /// Personal and invitation links are nobody's search result.
    noindex: bool,
}

async fn preview_for(state: &AppState, path: &str, query: &str) -> Preview {
    let locale = state.config.default_locale;
    let t = text::texts(locale);
    let path = path.trim_end_matches('/');
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let plain = |title: String, description: &str, image: &str, noindex: bool| Preview {
        title,
        description: description.to_owned(),
        image: image.to_owned(),
        noindex,
    };
    match segments.as_slice() {
        ["invite"] => {
            let token = query
                .split('&')
                .find_map(|pair| pair.strip_prefix("token="))
                .unwrap_or("");
            match crate::messaging::invitations::invitation_card(state, token).await {
                Ok(Some(card)) => Preview {
                    title: format!(
                        "{} {}",
                        text::invite_kicker(locale, card.invited_by.as_deref()),
                        card.space_name
                    ),
                    description: t.invite_description.to_owned(),
                    image: format!("invite/{token}"),
                    noindex: true,
                },
                _ => plain(
                    format!("{} {}", t.expired_kicker, t.expired_title),
                    &t.expired_sub.join(" "),
                    "expired.png",
                    true,
                ),
            }
        }
        ["verify-email"] | ["reset-password"] => plain(
            format!("{} · {}", t.personal_kicker, t.personal_title),
            &t.personal_sub.join(" "),
            if segments[0] == "verify-email" {
                "personal-verify.png"
            } else {
                "personal-reset.png"
            },
            true,
        ),
        ["status"] => {
            let (database, cache) = crate::http::probe(state).await;
            let (title, sub) = if database && cache {
                (t.status_ok_title, &t.status_ok_sub)
            } else {
                (t.status_ko_title, &t.status_ko_sub)
            };
            plain(
                format!("{} · {title}", t.status_kicker),
                &sub.join(" "),
                "status.png",
                false,
            )
        }
        ["e", _] => plain(t.space_title.join(" "), t.space_sub, "space.png", false),
        ["e", _, ..] => plain(
            t.message_title.join(" "),
            t.message_sub,
            "message.png",
            false,
        ),
        _ => plain(
            format!("Ruchoir · {}", state.mailer.instance_name()),
            t.home_description,
            "home.png",
            false,
        ),
    }
}

/// The `<meta>` tags for `preview`. The page's own address carries no query: an invitation or a
/// reset token is not repeated into the tags.
fn tags(preview: &Preview, state: &AppState, path: &str) -> String {
    let base = state.config.public_base_url.trim_end_matches('/');
    let title = escape(&preview.title);
    let description = escape(&preview.description);
    let image = escape(&format!("{base}/api/v1/og/{}", preview.image));
    let url = escape(&format!("{base}{path}"));
    let locale = og_locale(state.config.default_locale);
    let robots = if preview.noindex {
        r#"<meta name="robots" content="noindex">"#
    } else {
        ""
    };
    format!(
        r#"<meta property="og:type" content="website"><meta property="og:site_name" content="Ruchoir"><meta property="og:locale" content="{locale}"><meta property="og:url" content="{url}"><meta property="og:title" content="{title}"><meta property="og:description" content="{description}"><meta property="og:image" content="{image}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="{w}"><meta property="og:image:height" content="{h}"><meta property="og:image:alt" content="{title}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title}"><meta name="twitter:description" content="{description}"><meta name="twitter:image" content="{image}">{robots}"#,
        w = render::WIDTH,
        h = render::HEIGHT,
    )
}

fn og_locale(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "fr_FR",
        Locale::En => "en_GB",
        Locale::Es => "es_ES",
        Locale::De => "de_DE",
        Locale::It => "it_IT",
        Locale::Pl => "pl_PL",
    }
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// --- Images -----------------------------------------------------------------------------------------

/// The fixed cards, drawn once per process: their content depends only on the instance.
fn drawn() -> &'static Mutex<HashMap<String, Arc<Vec<u8>>>> {
    static DRAWN: OnceLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();
    DRAWN.get_or_init(Default::default)
}

async fn cached(key: String, card: Card, locale: Locale) -> Result<Arc<Vec<u8>>, StatusCode> {
    if let Some(png) = drawn().lock().expect("card cache").get(&key) {
        return Ok(png.clone());
    }
    let png = Arc::new(draw(card, locale).await?);
    drawn().lock().expect("card cache").insert(key, png.clone());
    Ok(png)
}

/// Rendering is CPU work (tens of milliseconds): it runs off the async workers.
async fn draw(card: Card, locale: Locale) -> Result<Vec<u8>, StatusCode> {
    tokio::task::spawn_blocking(move || render::render(&card, locale))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|err| {
            tracing::error!(error = %err, "link preview card failed to render");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

fn png(bytes: Vec<u8>, cache: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, cache),
        ],
        bytes,
    )
        .into_response()
}

/// `GET /api/v1/og/{name}`: one of the fixed cards, or the status card as it stands now.
async fn card_image(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let locale = state.config.default_locale;
    let card = match name.as_str() {
        "home.png" => Card::Home {
            instance: state.mailer.instance_name(),
        },
        "message.png" => Card::Message,
        "space.png" => Card::Space,
        "expired.png" => Card::InviteExpired,
        "personal-verify.png" => Card::Personal {
            path: "/verify-email",
        },
        "personal-reset.png" => Card::Personal {
            path: "/reset-password",
        },
        "status.png" => {
            let (database, cache) = crate::http::probe(&state).await;
            // Four possible pictures, each drawn once; the probe is what changes, and briefly cached
            // by the scraper so a recovered instance stops showing its incident soon after.
            return match cached(
                format!("status-{database}-{cache}"),
                Card::Status { database, cache },
                locale,
            )
            .await
            {
                Ok(bytes) => png(bytes.to_vec(), "public, max-age=60"),
                Err(status) => status.into_response(),
            };
        }
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    match cached(name, card, locale).await {
        Ok(bytes) => png(bytes.to_vec(), "public, max-age=86400"),
        Err(status) => status.into_response(),
    }
}

/// `GET /api/v1/og/invite/{token}`: the card of a valid invitation, or the expired one.
///
/// Only a token that resolves to a usable invitation is drawn with its details, so nobody can make
/// the server draw a card with text of their choosing; every other token gets the one expired card.
async fn invite_image(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    let locale = state.config.default_locale;
    let card = match crate::messaging::invitations::invitation_card(&state, &token).await {
        Ok(Some(card)) => card,
        Ok(None) => {
            return match cached("expired.png".into(), Card::InviteExpired, locale).await {
                Ok(bytes) => png(bytes.to_vec(), "public, max-age=600"),
                Err(status) => status.into_response(),
            };
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let card = Card::Invite {
        space: card.space_name,
        inviter: card.invited_by,
        members: card.members,
        channels: card.channels,
    };
    match draw(card, locale).await {
        Ok(bytes) => png(bytes, "public, max-age=600"),
        Err(status) => status.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    fn request(path: &str, accept: Option<&str>) -> Request {
        let mut builder = Request::builder().uri(path);
        if let Some(accept) = accept {
            builder = builder.header(header::ACCEPT, accept);
        }
        builder.body(Body::empty()).unwrap()
    }

    #[test]
    fn pages_are_told_from_files_and_api_calls() {
        assert!(is_page_request(&request(
            "/",
            Some("text/html,application/xhtml+xml")
        )));
        // Scrapers: no Accept at all, or anything.
        assert!(is_page_request(&request("/invite?token=abc", None)));
        assert!(is_page_request(&request(
            "/e/atelier/c/general",
            Some("*/*")
        )));
        assert!(is_page_request(&request("/status/", Some("text/html"))));
        // Files keep their 404, the API its JSON.
        assert!(!is_page_request(&request("/missing.js", Some("*/*"))));
        assert!(!is_page_request(&request("/api/v1/nope", Some("*/*"))));
        assert!(!is_page_request(&request("/_next/static/x", None)));
        assert!(!is_page_request(&request("/", Some("application/json"))));
    }

    #[test]
    fn exported_pages_keep_their_own_file_and_the_rest_is_the_shell() {
        let dir = std::env::temp_dir().join(format!("ruchoir-og-pages-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("index.html"), "shell").unwrap();
        std::fs::write(dir.join("docs/index.html"), "docs").unwrap();
        assert_eq!(page_file(&dir, "/docs/"), dir.join("docs/index.html"));
        assert_eq!(page_file(&dir, "/docs"), dir.join("docs/index.html"));
        assert_eq!(page_file(&dir, "/"), dir.join("index.html"));
        assert_eq!(
            page_file(&dir, "/e/atelier/c/general"),
            dir.join("index.html")
        );
        assert_eq!(page_file(&dir, "/../docs"), dir.join("index.html"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tag_values_are_escaped() {
        assert_eq!(
            escape(r#"a "b" <c> & d"#),
            "a &quot;b&quot; &lt;c&gt; &amp; d"
        );
    }
}
