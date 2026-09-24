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
//! - **Only HTML, only the start of it**: 512 KiB read at most, five seconds in all, and only the
//!   title and description are kept. No image is fetched.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::OnceLock;
use std::time::Duration;

use axum::http::Uri;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use time::OffsetDateTime;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use uuid::Uuid;

use crate::entities::{message_link_previews, messages};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

use super::authz;

/// How much of a page is read. The `<head>` is nearly always well within it.
const MAX_BYTES: u64 = 512 * 1024;

/// How long a stored preview is reused for the same URL before the page is read again.
const REUSE_FOR: time::Duration = time::Duration::hours(24);

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
    }
}

/// Fetch a page and summarise it. `None` for anything that is not a readable HTML page.
fn fetch(url: &str, user_agent: &str) -> Option<PageSummary> {
    let mut response = agent()
        .get(url)
        .header("User-Agent", user_agent)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let is_html = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            let v = v.to_ascii_lowercase();
            v.contains("text/html") || v.contains("application/xhtml")
        });
    if !is_html {
        return None;
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let summary = summarise(&String::from_utf8_lossy(&bytes));
    (summary.title.is_some() || summary.description.is_some()).then_some(summary)
}

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
            tracing::debug!(?error, %message_id, "link preview not updated");
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
        let summary = match recent {
            Some(row) => Some(PageSummary {
                title: row.title,
                description: row.description,
            }),
            None => {
                let user_agent = format!(
                    "Mozilla/5.0 (compatible; RuchoirLinkPreview/1.0; +{})",
                    state.config.public_base_url.trim_end_matches('/')
                );
                let target = url.clone();
                tokio::task::spawn_blocking(move || fetch(&target, &user_agent))
                    .await
                    .ok()
                    .flatten()
            }
        };
        if let Some(summary) = summary {
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
            assert!(summary.is_some_and(|s| s.title.is_some()), "{url}");
        }
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        let long = "é".repeat(400);
        let cut = clean(&long, MAX_DESCRIPTION).unwrap();
        assert_eq!(cut.chars().count(), MAX_DESCRIPTION + 1);
        assert!(cut.ends_with('\u{2026}'));
    }
}
