//! Link previews ("unfurls"), fetched by this server and by no one else.
//!
//! When a message contains a link, the API reads the page's title and description itself and stores
//! them next to the message (`message_link_previews`), then pushes the updated message so the card
//! appears for everyone. No third-party unfurl service, and nothing is fetched by the readers'
//! browsers: the strict CSP forbids it, and a reader's browser must never be made to contact an
//! address because someone else wrote it. The only party that learns the link was shared is the
//! site itself, which sees a request from this instance.
//!
//! A server that fetches URLs its users type is a request forgery waiting to happen, so every
//! fetch is fenced:
//!
//! - **Only public addresses.** The name is resolved by [`PublicOnlyResolver`], which drops every
//!   loopback, private, link-local, shared, documentation and multicast address (IPv4-mapped and
//!   NAT64 forms included) *before* connecting, on the first request and on every redirect. The
//!   check and the connection use the same resolution, so a name cannot answer differently between
//!   the two.
//! - **Only ports 80 and 443**, over `http` and `https`, at most three redirects.
//! - **Not this instance's own domain** ([`crate::config::Config::unfurl_deny_hosts`]): services
//!   published next to it behind an address filter (a mail catcher, an admin page) would let this
//!   server read what the filter keeps from everyone else.
//! - **Only HTML, only its head**: read up to the end of `<head>`, 2 MiB at most, five seconds in
//!   all. Kept: the title, the description, the site's `theme-color`, and its preview image
//!   (`og:image`).
//!
//! The preview image goes through the same fence (the same resolver, the same deny list), must
//! announce itself as an image, is read up to 5 MiB, decoded and re-encoded as a JPEG thumbnail
//! (never stored as received), and kept in the object store under a name derived from its URL. It
//! is served from this instance by [`preview_image`], to members of the conversation only.
//!
//! A thumbnail is about 13 KB, and one image shared many times is stored once. It is removed from the
//! store when the last preview showing it goes (the link edited away, the message deleted), so the
//! store stays the size of what is on screen. Every failure (a page that is not HTML, an address
//! refused, a timeout) is logged as a warning with its reason.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, Uri};
use axum::response::{IntoResponse, Response};
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{message_link_previews, messages};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

use super::authz;

/// How much of a page may be read looking for the end of its `<head>`. Reading stops there, so this
/// is only reached by a page whose head is huge: a YouTube video page puts its title and preview
/// tags after 700 KB of inline scripts, which a 512 KiB cap cut off.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// Read a page up to the end of its `<head>` (everything the preview needs), or [`MAX_BYTES`].
fn read_head(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        // Look for the closing tag in what just arrived, plus a few bytes before it in case the
        // tag straddles two chunks.
        let from = bytes.len().saturating_sub(6);
        bytes.extend_from_slice(&chunk[..read]);
        let found = bytes[from..]
            .windows(7)
            .any(|w| w.eq_ignore_ascii_case(b"</head>"));
        if found || bytes.len() >= MAX_BYTES {
            break;
        }
    }
    bytes.truncate(MAX_BYTES);
    Ok(bytes)
}

/// How long a stored preview is reused for the same URL before the page is read again.
const REUSE_FOR: time::Duration = time::Duration::hours(24);

/// How much of a preview image is read, and the longest edge of the thumbnail kept of it.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const THUMBNAIL_PX: u32 = 480;

const MAX_TITLE: usize = 200;
const MAX_DESCRIPTION: usize = 300;

/// Whether an address is on the public internet, and so may be fetched.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address: judge that one.
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                return is_public_v4(Ipv4Addr::new(
                    (s[6] >> 8) as u8,
                    s[6] as u8,
                    (s[7] >> 8) as u8,
                    s[7] as u8,
                ));
            }
            if s[0] == 0x2002 {
                return is_public_v4(Ipv4Addr::new(
                    (s[1] >> 8) as u8,
                    s[1] as u8,
                    (s[2] >> 8) as u8,
                    s[2] as u8,
                ));
            }
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link-local
                || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || s[0] == 0x0100 && s[1..4] == [0, 0, 0]) // discard-only
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240) // reserved
}

/// A resolver that only ever hands the connector public addresses, and only for ports 80 and 443.
#[derive(Debug, Default)]
struct PublicOnlyResolver {
    inner: DefaultResolver,
}

impl Resolver for PublicOnlyResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &ureq::config::Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let port = uri.port_u16().unwrap_or(match uri.scheme_str() {
            Some("https") => 443,
            _ => 80,
        });
        if port != 80 && port != 443 {
            return Err(ureq::Error::HostNotFound);
        }
        let resolved = self.inner.resolve(uri, config, timeout)?;
        let mut public = self.empty();
        for addr in resolved.iter().filter(|addr| is_public(addr.ip())) {
            public.push(*addr);
        }
        if public.is_empty() {
            Err(ureq::Error::HostNotFound)
        } else {
            Ok(public)
        }
    }
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(5)))
            .max_redirects(3)
            .http_status_as_error(false)
            .build();
        ureq::Agent::with_parts(
            config,
            DefaultConnector::new(),
            PublicOnlyResolver::default(),
        )
    })
}

/// The first link in a message, outside code, with the punctuation that usually follows a link in a
/// sentence left out (the web client draws the link the same way).
pub fn first_link(body: &str) -> Option<String> {
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Inline code spans are skipped: every other backtick opens or closes one.
        for (index, part) in line.split('`').enumerate() {
            if index % 2 == 1 {
                continue;
            }
            let mut rest = part;
            while let Some(at) = rest.find("http") {
                let candidate = &rest[at..];
                if candidate.starts_with("https://") || candidate.starts_with("http://") {
                    let end = candidate
                        .find(char::is_whitespace)
                        .unwrap_or(candidate.len());
                    let url = trim_trailing(&candidate[..end]);
                    if url.len() > "https://".len() {
                        return Some(url.to_owned());
                    }
                }
                rest = &rest[at + 4..];
            }
        }
    }
    None
}

/// Drop the sentence punctuation after a link, keeping a closing bracket the link itself opened
/// (`https://en.wikipedia.org/wiki/Rust_(language)`).
pub fn trim_trailing(url: &str) -> &str {
    let mut end = url.len();
    while let Some(last) = url[..end].chars().last() {
        let drop = match last {
            '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '>' | '*' | '_' => true,
            ')' => url[..end].matches('(').count() < url[..end].matches(')').count(),
            ']' => url[..end].matches('[').count() < url[..end].matches(']').count(),
            _ => false,
        };
        if !drop {
            break;
        }
        end -= last.len_utf8();
    }
    &url[..end]
}

/// The host of a link, lower-cased, when it is one this server may read.
fn fetchable_host(url: &str, deny: &[String]) -> Option<String> {
    let uri: Uri = url.parse().ok()?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) {
        return None;
    }
    let authority = uri.authority()?;
    if authority.as_str().contains('@') {
        return None;
    }
    let host = authority
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    // A literal address is judged directly; a name is judged at resolution.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public(ip) {
            return None;
        }
    }
    let denied = deny
        .iter()
        .any(|d| !d.is_empty() && (host == *d || host.ends_with(&format!(".{d}"))));
    (!denied).then_some(host)
}

/// What a page says about itself.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PageSummary {
    pub title: Option<String>,
    pub description: Option<String>,
    /// The site's colour, as `#rrggbb`.
    pub color: Option<String>,
    /// The preview image's address, absolute once [`fetch`] has resolved it against the page.
    pub image: Option<String>,
}

/// A `theme-color` as `#rrggbb`, or `None` for anything but a plain hex colour (a name, `rgb()`,
/// a variable): the value ends up in a style attribute, so only what cannot be anything else is kept.
fn hex_color(raw: &str) -> Option<String> {
    let hex = raw.trim().strip_prefix('#')?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let full = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => hex.to_owned(),
        _ => return None,
    };
    Some(format!("#{}", full.to_ascii_lowercase()))
}

/// Resolve a reference found in a page against the page's own address: absolute, scheme-relative
/// (`//cdn.example/x.png`), root-relative (`/x.png`) or relative (`img/x.png`). Only `http(s)`.
fn resolve(base: &Uri, reference: &str) -> Option<String> {
    let reference = decode_entities(reference.trim());
    if reference.starts_with("https://") || reference.starts_with("http://") {
        return Some(reference);
    }
    let scheme = base.scheme_str()?;
    let authority = base.authority()?;
    if let Some(rest) = reference.strip_prefix("//") {
        return Some(format!("{scheme}://{rest}"));
    }
    if reference.contains(':') && !reference.starts_with('/') {
        // `data:`, `javascript:` and every other scheme: never.
        return None;
    }
    if reference.starts_with('/') {
        return Some(format!("{scheme}://{authority}{reference}"));
    }
    let path = base.path();
    let dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
    let dir = if dir.is_empty() { "/" } else { dir };
    Some(format!("{scheme}://{authority}{dir}{reference}"))
}

/// Decode the handful of HTML entities a title or a description actually contains.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Collapse whitespace, decode entities and cap the length, on a character boundary.
fn clean(raw: &str, max: usize) -> Option<String> {
    let text = decode_entities(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= max {
        return Some(text);
    }
    let cut: String = text.chars().take(max).collect();
    Some(format!("{}\u{2026}", cut.trim_end()))
}

/// The value of one attribute inside a tag's source, quoted or not.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let at = from + found;
        from = at + name.len();
        // A whole attribute name, not the end of another one (`data-content`).
        let before = lower[..at].chars().last();
        if before.is_some_and(|c| !c.is_whitespace()) {
            continue;
        }
        let rest = tag[at + name.len()..].trim_start();
        let Some(value) = rest.strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        return match value.chars().next() {
            Some(quote @ ('"' | '\'')) => value[1..].split(quote).next().map(str::to_owned),
            Some(_) => value
                .split(|c: char| c.is_whitespace() || c == '>')
                .next()
                .map(str::to_owned),
            None => None,
        };
    }
    None
}

/// Read the title and description from a page's HTML: Open Graph first, then the plain `<title>`
/// and `<meta name="description">`.
pub fn summarise(html: &str) -> PageSummary {
    // Only the head matters, and cutting there keeps a script or a comment further down from
    // being taken for a tag.
    let head_end = html
        .to_ascii_lowercase()
        .find("</head>")
        .unwrap_or(html.len());
    let head = &html[..head_end];
    let lower = head.to_ascii_lowercase();

    let mut og_title = None;
    let mut og_description = None;
    let mut description = None;
    let mut color = None;
    let mut image = None;
    let mut from = 0;
    while let Some(found) = lower[from..].find("<meta") {
        let start = from + found;
        let end = lower[start..].find('>').map_or(head.len(), |e| start + e);
        let tag = &head[start..end];
        from = end.max(start + 5);
        let key = attribute(tag, "property")
            .or_else(|| attribute(tag, "name"))
            .map(|k| k.to_ascii_lowercase());
        // An empty value is as good as none: sites declare `og:title` and leave it blank, and taking
        // it would hide the `<title>` they did fill in.
        let Some(content) = attribute(tag, "content").filter(|c| !c.trim().is_empty()) else {
            continue;
        };
        match key.as_deref() {
            Some("og:title") | Some("twitter:title") if og_title.is_none() => {
                og_title = Some(content)
            }
            Some("og:description") | Some("twitter:description") if og_description.is_none() => {
                og_description = Some(content)
            }
            Some("description") if description.is_none() => description = Some(content),
            // The first one: sites list a light and a dark variant, in that order more often than not.
            Some("theme-color") if color.is_none() => color = hex_color(&content),
            Some("og:image")
            | Some("og:image:url")
            | Some("og:image:secure_url")
            | Some("twitter:image")
            | Some("twitter:image:src")
                if image.is_none() =>
            {
                image = Some(content)
            }
            _ => {}
        }
    }
    let title_tag = lower.find("<title").and_then(|start| {
        let open_end = start + lower[start..].find('>')? + 1;
        let close = open_end + lower[open_end..].find("</title")?;
        Some(head[open_end..close].to_owned())
    });

    PageSummary {
        title: og_title.or(title_tag).and_then(|t| clean(&t, MAX_TITLE)),
        description: og_description
            .or(description)
            .and_then(|d| clean(&d, MAX_DESCRIPTION)),
        color,
        image,
    }
}

/// Fetch a page and summarise it, or say why it could not be: the reason goes to the log, so a
/// link without a preview can be explained without guessing.
fn fetch(url: &str, user_agent: &str) -> Result<PageSummary, String> {
    use ureq::ResponseExt;
    let mut response = agent()
        .get(url)
        .header("User-Agent", user_agent)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|e| match e {
            ureq::Error::HostNotFound => "not a public address, or no such host".to_owned(),
            other => other.to_string(),
        })?;
    if !response.status().is_success() {
        return Err(format!("status {}", response.status().as_u16()));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !(content_type.contains("text/html") || content_type.contains("application/xhtml")) {
        return Err(format!("not an HTML page ({content_type})"));
    }
    // Relative references resolve against where the page ended up, after any redirect.
    let page = response.get_uri().clone();
    let bytes = read_head(&mut response.body_mut().as_reader()).map_err(|e| e.to_string())?;
    let mut summary = summarise(&String::from_utf8_lossy(&bytes));
    summary.image = summary.image.and_then(|image| resolve(&page, &image));
    if summary.title.is_none() && summary.description.is_none() {
        return Err("no title or description in the page".to_owned());
    }
    Ok(summary)
}

/// Fetch a preview image and reduce it to a JPEG thumbnail: `(thumbnail, width, height)`, the size
/// being the original's. An error, with its reason, for anything but a decodable image of
/// reasonable size.
fn fetch_image(url: &str, user_agent: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let mut response = agent()
        .get(url)
        .header("User-Agent", user_agent)
        .header("Accept", "image/*")
        .call()
        .map_err(|e| match e {
            ureq::Error::HostNotFound => "not a public address, or no such host".to_owned(),
            other => other.to_string(),
        })?;
    if !response.status().is_success() {
        return Err(format!("status {}", response.status().as_u16()));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.starts_with("image/") {
        return Err(format!("not an image ({content_type})"));
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("larger than 5 MiB".to_owned());
    }
    let info = crate::files::thumbnail::make_thumbnail(&bytes, THUMBNAIL_PX)
        .map_err(|e| format!("not a decodable image: {e}"))?;
    Ok((info.thumbnail, info.width, info.height))
}

/// Whether a colour would vanish on a light card: every channel near white.
fn is_near_white(hex: &str) -> bool {
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    hex.len() == 7 && (1..7).step_by(2).all(|i| channel(i) >= 0xe6)
}

/// The dominant vivid colour of an image, as `#rrggbb`: the average of its saturated, mid-light
/// pixels, when there are enough of them to be the image's colour rather than a detail. The site's
/// own colour when it declares none (or a white one): YouTube's red, from its preview image.
fn accent_from_image(jpeg: &[u8]) -> Option<String> {
    let image = image::load_from_memory(jpeg).ok()?.to_rgb8();
    let (mut r, mut g, mut b, mut vivid, mut total) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for pixel in image.pixels().step_by(3) {
        let [pr, pg, pb] = pixel.0;
        total += 1;
        let max = pr.max(pg).max(pb);
        let min = pr.min(pg).min(pb);
        // Chroma above a quarter of the range, and neither near black nor near white.
        if max - min > 64 && max > 60 && min < 220 {
            vivid += 1;
            r += u64::from(pr);
            g += u64::from(pg);
            b += u64::from(pb);
        }
    }
    // At least 3% of the picture, or it is a logo's detail rather than the image's colour.
    if vivid == 0 || vivid * 100 < total * 3 {
        return None;
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        r / vivid,
        g / vivid,
        b / vivid
    ))
}

/// The thumbnail's object-store key: one per image address, so the same image shared again is
/// stored once.
fn image_key(image_url: &str) -> String {
    let digest = Sha256::digest(image_url.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("link-previews/{hex}.jpg")
}

/// The thumbnail of a page's preview image, stored and ready: `(key, width, height)`.
///
/// Without it the card is drawn without an image, and the reason is logged.
async fn store_image(
    state: &AppState,
    image_url: String,
    user_agent: String,
) -> Option<(StoredImage, Option<String>)> {
    let storage = state.storage.clone()?;
    if fetchable_host(&image_url, &state.config.unfurl_deny_hosts).is_none() {
        tracing::warn!(image = %image_url, "link preview image not fetched: address refused");
        return None;
    }
    let key = image_key(&image_url);
    let target = image_url.clone();
    let fetched = tokio::task::spawn_blocking(move || {
        let (thumbnail, width, height) = fetch_image(&target, &user_agent)?;
        let accent = accent_from_image(&thumbnail);
        Ok::<_, String>((thumbnail, width, height, accent))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    let (thumbnail, width, height, accent) = match fetched {
        Ok(fetched) => fetched,
        Err(reason) => {
            tracing::warn!(image = %image_url, %reason, "link preview image not fetched");
            return None;
        }
    };
    if let Err(error) = storage.put(&key, &thumbnail, "image/jpeg").await {
        tracing::warn!(%error, "link preview image not stored");
        return None;
    }
    Some(((key, width as i32, height as i32), accent))
}

/// [`forget_image`] for every thumbnail a deletion released (a channel's, a space's).
pub async fn forget_images(state: &AppState, keys: Vec<String>) {
    let mut keys = keys;
    keys.sort();
    keys.dedup();
    for key in keys {
        forget_image(state, &key).await;
    }
}

/// Remove a thumbnail from the object store once no preview points at it any more.
///
/// Thumbnails are shared between the previews of the same image (the key comes from the image's
/// address), so one is removed only with its last user. About 13 KB each: this keeps the store the
/// size of what is actually shown, instead of growing with every link ever edited away or deleted.
async fn forget_image(state: &AppState, key: &str) {
    let still_used = message_link_previews::Entity::find()
        .filter(message_link_previews::Column::ImageKey.eq(key))
        .one(&state.db)
        .await;
    match (still_used, state.storage.as_ref()) {
        (Ok(None), Some(storage)) => {
            if let Err(error) = storage.delete(key).await {
                tracing::warn!(%error, %key, "link preview image not removed");
            }
        }
        (Err(error), _) => tracing::warn!(%error, "link preview image left in place"),
        _ => {}
    }
}

/// A stored thumbnail: its key, and the original image's width and height.
type StoredImage = (String, i32, i32);

/// Bring a message's preview in line with its body, in the background: fetch one for its first
/// link, replace one whose link was edited away, drop one whose link is gone. Pushes the message
/// again when the preview changed. Never fails the request that triggered it.
pub fn refresh(state: &AppState, message_id: Uuid) {
    if !state.config.unfurl_enabled {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = run(&state, message_id).await {
            tracing::warn!(?error, %message_id, "link preview not updated");
        }
    });
}

async fn run(state: &AppState, message_id: Uuid) -> Result<(), super::error::ApiError> {
    let Some(message) = messages::Entity::find_by_id(message_id)
        .one(&state.db)
        .await?
    else {
        return Ok(());
    };
    let wanted = if message.deleted_at.is_some() {
        None
    } else {
        first_link(&message.body)
            .filter(|url| fetchable_host(url, &state.config.unfurl_deny_hosts).is_some())
    };
    let current = message_link_previews::Entity::find()
        .filter(message_link_previews::Column::MessageId.eq(message_id))
        .one(&state.db)
        .await?;
    if current.as_ref().map(|p| p.url.as_str()) == wanted.as_deref() {
        return Ok(());
    }

    let mut changed = false;
    if let Some(old) = current {
        message_link_previews::Entity::delete_by_id(old.id)
            .exec(&state.db)
            .await?;
        if let Some(key) = old.image_key.as_deref() {
            forget_image(state, key).await;
        }
        changed = true;
    }

    if let Some(url) = wanted {
        let now = OffsetDateTime::now_utc();
        // The same page shared again recently is not read again.
        let recent = message_link_previews::Entity::find()
            .filter(message_link_previews::Column::Url.eq(url.clone()))
            .filter(message_link_previews::Column::FetchedAt.gt(now - REUSE_FOR))
            .order_by_desc(message_link_previews::Column::FetchedAt)
            .one(&state.db)
            .await?;
        let user_agent = format!(
            "Mozilla/5.0 (compatible; RuchoirLinkPreview/1.0; +{})",
            state.config.public_base_url.trim_end_matches('/')
        );
        // What the card shows: the text, the colour, and the stored thumbnail with its size.
        type Look = (PageSummary, Option<StoredImage>);
        let look: Option<Look> = match recent {
            Some(row) => {
                let image = match (row.image_key, row.image_width, row.image_height) {
                    (Some(key), Some(width), Some(height)) => Some((key, width, height)),
                    _ => None,
                };
                Some((
                    PageSummary {
                        title: row.title,
                        description: row.description,
                        color: row.color,
                        image: None,
                    },
                    image,
                ))
            }
            None => {
                let target = url.clone();
                let agent_name = user_agent.clone();
                let summary = tokio::task::spawn_blocking(move || fetch(&target, &agent_name))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|result| result);
                match summary {
                    Ok(mut summary) => {
                        let stored = match summary.image.clone() {
                            Some(image_url) => store_image(state, image_url, user_agent).await,
                            None => None,
                        };
                        // A white site colour disappears on the card; the image's own colour
                        // stands in for it, as it does when the page declares none.
                        if summary.color.as_deref().is_none_or(is_near_white) {
                            summary.color = stored.as_ref().and_then(|(_, accent)| accent.clone());
                        }
                        Some((summary, stored.map(|(image, _)| image)))
                    }
                    Err(reason) => {
                        tracing::warn!(%url, %reason, "no link preview");
                        None
                    }
                }
            }
        };
        if let Some((summary, image)) = look {
            let domain = fetchable_host(&url, &[]).unwrap_or_default();
            let domain = domain.strip_prefix("www.").unwrap_or(&domain).to_owned();
            message_link_previews::ActiveModel {
                id: Set(Uuid::new_v4()),
                message_id: Set(message_id),
                url: Set(url),
                domain: Set(domain),
                title: Set(summary.title),
                description: Set(summary.description),
                image_file_id: Set(None),
                color: Set(summary.color),
                image_key: Set(image.as_ref().map(|(key, _, _)| key.clone())),
                image_width: Set(image.as_ref().map(|(_, width, _)| *width)),
                image_height: Set(image.as_ref().map(|(_, _, height)| *height)),
                fetched_at: Set(now),
                expires_at: Set(None),
            }
            .insert(&state.db)
            .await?;
            changed = true;
        }
    }

    if changed {
        publish(state, message).await?;
    }
    Ok(())
}

/// `GET /api/v1/link-previews/{preview_id}/image`: a preview's thumbnail, for members of the
/// conversation the link was shared in. Served by this instance: the reader's browser never
/// contacts the site.
#[utoipa::path(
    get,
    path = "/api/v1/link-previews/{preview_id}/image",
    tag = "messaging",
    params(("preview_id" = Uuid, Path, description = "Link preview id")),
    responses(
        (status = 200, description = "JPEG thumbnail", content_type = "image/jpeg"),
        (status = 404, description = "No such preview, no image, or not a member of its conversation")
    )
)]
pub async fn preview_image(
    State(state): State<AppState>,
    session: AuthSession,
    Path(preview_id): Path<Uuid>,
) -> Result<Response, super::error::ApiError> {
    use super::error::ApiError;
    let preview = message_link_previews::Entity::find_by_id(preview_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    let key = preview.image_key.ok_or(ApiError::NotFound)?;
    let message = messages::Entity::find_by_id(preview.message_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    // A 404 either way: whether a preview exists is none of a non-member's business.
    authz::ensure_conversation_access(&state.db, message.conversation_id, session.user_id)
        .await
        .map_err(|_| ApiError::NotFound)?;
    let storage = state.storage.as_ref().ok_or(ApiError::NotFound)?;
    let bytes = storage.get(&key).await.map_err(|_| ApiError::NotFound)?;
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=86400"),
            ),
        ],
        bytes,
    )
        .into_response())
}

/// Push the message again, as its author sees it, the way an edit is pushed.
async fn publish(state: &AppState, message: messages::Model) -> Result<(), super::error::ApiError> {
    let author = message.author_id.unwrap_or_default();
    let conversation_id = message.conversation_id;
    let access = authz::ensure_conversation_access(&state.db, conversation_id, author).await?;
    let audience = authz::conversation_audience(&state.db, &access).await?;
    let Some(dto) = super::messages::hydrate_messages(&state.db, author, vec![message])
        .await?
        .pop()
    else {
        return Ok(());
    };
    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::message_updated(conversation_id, dto),
        )
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_addresses_are_fetched() {
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.20",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "64:ff9b::a00:1",
            "2002:c0a8:0101::1",
            "2001:db8::1",
        ] {
            assert!(
                !is_public(private.parse().unwrap()),
                "{private} must be refused"
            );
        }
        for public in ["1.1.1.1", "92.162.84.19", "2a01:e0a::1", "::ffff:1.1.1.1"] {
            assert!(is_public(public.parse().unwrap()), "{public} is public");
        }
    }

    #[test]
    fn a_name_that_resolves_inside_is_never_connected_to() {
        // The literal check cannot see this one, only the resolver can. `HostNotFound` is the
        // resolver's refusal; a connection attempt would fail differently (or succeed, on a machine
        // with a web server on port 80).
        for url in [
            "http://localhost/",
            "https://localhost/",
            "http://localhost:8080/",
        ] {
            let outcome = agent().get(url).call();
            assert!(
                matches!(outcome, Err(ureq::Error::HostNotFound)),
                "{url}: {outcome:?}"
            );
        }
    }

    #[test]
    fn the_first_link_outside_code_is_the_one() {
        assert_eq!(
            first_link("voir https://example.org/a, puis https://example.org/b").as_deref(),
            Some("https://example.org/a")
        );
        assert_eq!(
            first_link("`https://code.example` puis https://real.example.").as_deref(),
            Some("https://real.example")
        );
        assert_eq!(
            first_link("```\nhttps://fenced.example\n```\n(voir https://after.example)").as_deref(),
            Some("https://after.example")
        );
        assert_eq!(
            first_link("https://en.wikipedia.org/wiki/Rust_(language)").as_deref(),
            Some("https://en.wikipedia.org/wiki/Rust_(language)")
        );
        assert_eq!(first_link("pas de lien, juste http et https"), None);
    }

    #[test]
    fn this_instances_domain_and_literal_private_addresses_are_not_read() {
        let deny = vec!["theovilain.fr".to_owned()];
        assert!(fetchable_host("https://ruchoir-dev.theovilain.fr/mailpit/", &deny).is_none());
        assert!(fetchable_host("https://theovilain.fr/", &deny).is_none());
        assert!(fetchable_host("http://192.168.1.20:8025/", &deny).is_none());
        assert!(fetchable_host("http://[::1]/", &deny).is_none());
        assert!(fetchable_host("https://user@example.org/", &deny).is_none());
        assert!(fetchable_host("ftp://example.org/", &deny).is_none());
        assert_eq!(
            fetchable_host("https://Example.ORG/page", &deny).as_deref(),
            Some("example.org")
        );
        assert!(fetchable_host("https://nottheovilain.fr/", &deny).is_some());
    }

    #[test]
    fn open_graph_wins_and_entities_are_decoded() {
        let html = r#"<!doctype html><html><head>
            <title>Plain &amp; simple</title>
            <meta name="description" content="Fallback">
            <meta property="og:title" content="Le &quot;vrai&quot; titre &#8211; ici">
            <meta content='Une description
                 sur deux lignes' property='og:description'>
            </head><body><meta property="og:title" content="not in head"></body></html>"#;
        let summary = summarise(html);
        assert_eq!(
            summary.title.as_deref(),
            Some("Le \"vrai\" titre \u{2013} ici")
        );
        assert_eq!(
            summary.description.as_deref(),
            Some("Une description sur deux lignes")
        );
    }

    #[test]
    fn a_page_without_open_graph_falls_back_to_its_title() {
        let summary = summarise(
            "<html><head><TITLE>\n  Bonjour  le monde </TITLE><meta name=description content=Court></head></html>",
        );
        assert_eq!(summary.title.as_deref(), Some("Bonjour le monde"));
        assert_eq!(summary.description.as_deref(), Some("Court"));
        assert_eq!(
            summarise("<html><body>rien</body></html>"),
            PageSummary::default()
        );
        let blank_og = summarise(
            r#"<head><meta property="og:title" content="" /><title> Vrai titre </title></head>"#,
        );
        assert_eq!(blank_og.title.as_deref(), Some("Vrai titre"));
    }

    /// Reads real pages over the network: run by hand (`cargo test -- --ignored unfurl`) to check
    /// the whole chain, TLS and redirects included, from the machine that will run it.
    #[test]
    #[ignore = "needs the network"]
    fn real_pages_are_read() {
        for url in [
            "https://www.rust-lang.org/",
            "https://fr.wikipedia.org/wiki/Rust_(langage)",
            "http://example.com/",
        ] {
            let summary = fetch(url, "Mozilla/5.0 (compatible; RuchoirLinkPreview/1.0)");
            println!("{url}: {summary:?}");
            assert!(summary.is_ok_and(|s| s.title.is_some()), "{url}");
        }
        for url in [
            "https://www.youtube.com/",
            // A video page: its head runs past 700 KB of inline scripts before the tags.
            "https://www.youtube.com/watch?v=FAtWNmjkFXw",
            "https://github.com/rust-lang/rust",
        ] {
            let summary = fetch(url, "Mozilla/5.0 (compatible; RuchoirLinkPreview/1.0)").unwrap();
            println!("{url}: {summary:?}");
            let image = summary.image.expect("an og:image");
            let thumbnail = fetch_image(&image, "Mozilla/5.0 (compatible; RuchoirLinkPreview/1.0)");
            println!(
                "  image {image}: {:?}",
                thumbnail.as_ref().map(|(b, w, h)| (b.len(), w, h))
            );
            // A site that rate-limits repeated runs of this test is not a failure of the code.
            if thumbnail.as_ref().is_err_and(|e| e == "status 429") {
                continue;
            }
            assert!(thumbnail.is_ok(), "{image}");
        }
    }

    #[test]
    fn the_sites_colour_and_image_are_read() {
        let summary = summarise(
            r##"<head><title>T</title>
            <meta name="theme-color" content="#F03" media="(prefers-color-scheme: light)">
            <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
            <meta property="og:image" content="/img/card.png?a=1&amp;b=2"></head>"##,
        );
        assert_eq!(summary.color.as_deref(), Some("#ff0033"));
        assert_eq!(summary.image.as_deref(), Some("/img/card.png?a=1&amp;b=2"));
        for unsafe_color in ["red", "rgb(1,2,3)", "#12345", "#12\"; x", "var(--c)"] {
            assert_eq!(hex_color(unsafe_color), None, "{unsafe_color}");
        }
    }

    #[test]
    fn the_colour_comes_from_the_image_when_the_site_gives_a_usable_one_of_none() {
        use image::{ImageFormat, Rgb, RgbImage};
        let encode = |img: RgbImage| {
            let mut out = Vec::new();
            img.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Jpeg)
                .unwrap();
            out
        };
        // A red logo on white: the red, not the white and not a pink average of the two.
        let mut logo = RgbImage::from_pixel(60, 60, Rgb([255, 255, 255]));
        for x in 20..40 {
            for y in 20..40 {
                logo.put_pixel(x, y, Rgb([230, 20, 20]));
            }
        }
        let accent = accent_from_image(&encode(logo)).unwrap();
        let red = u8::from_str_radix(&accent[1..3], 16).unwrap();
        let green = u8::from_str_radix(&accent[3..5], 16).unwrap();
        assert!(red > 180 && green < 70, "{accent}");
        // Nothing vivid in a grey picture.
        assert_eq!(
            accent_from_image(&encode(RgbImage::from_pixel(40, 40, Rgb([128, 128, 128])))),
            None
        );
        assert!(is_near_white("#ffffff"));
        assert!(is_near_white("#f0f0f0"));
        assert!(!is_near_white("#1e2327"));
    }

    #[test]
    fn image_references_resolve_against_the_page() {
        let page: Uri = "https://example.org/blog/post.html".parse().unwrap();
        for (reference, expected) in [
            (
                "https://cdn.example/a.png",
                Some("https://cdn.example/a.png"),
            ),
            ("//cdn.example/a.png", Some("https://cdn.example/a.png")),
            ("/a.png", Some("https://example.org/a.png")),
            ("img/a.png", Some("https://example.org/blog/img/a.png")),
            (
                "/x.png?a=1&amp;b=2",
                Some("https://example.org/x.png?a=1&b=2"),
            ),
            ("data:image/png;base64,AAAA", None),
            ("javascript:alert(1)", None),
        ] {
            assert_eq!(
                resolve(&page, reference).as_deref(),
                expected,
                "{reference}"
            );
        }
    }

    #[test]
    fn reading_stops_at_the_end_of_the_head_even_far_into_the_page() {
        // A head as long as a YouTube video page's, then a body that must not be read.
        let mut page = b"<html><HEAD><script>".to_vec();
        page.extend(std::iter::repeat_n(b'x', 720 * 1024));
        page.extend_from_slice(b"</script><title>Found</title></HeAd><body>");
        page.extend(std::iter::repeat_n(b'y', 3 * 1024 * 1024));
        let head = read_head(&mut page.as_slice()).unwrap();
        assert!(head.len() < 800 * 1024, "stopped at the head, not the cap");
        assert_eq!(
            summarise(&String::from_utf8_lossy(&head)).title.as_deref(),
            Some("Found")
        );
        // A page with no end to its head stops at the cap.
        let endless = vec![b'z'; 5 * 1024 * 1024];
        assert_eq!(read_head(&mut endless.as_slice()).unwrap().len(), MAX_BYTES);
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        let long = "é".repeat(400);
        let cut = clean(&long, MAX_DESCRIPTION).unwrap();
        assert_eq!(cut.chars().count(), MAX_DESCRIPTION + 1);
        assert!(cut.ends_with('\u{2026}'));
    }
}
