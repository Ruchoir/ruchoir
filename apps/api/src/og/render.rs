//! The link preview cards, drawn as SVG and rendered to a 1200x630 PNG.
//!
//! Every card follows one layout, taken from the design mockups: the Ruchoir wordmark and a short
//! text on the left, a tilted card on the right that shows what the link is (a conversation, a
//! space, an invitation), and the Ruchoir bee between the two, carrying something that says the
//! same. Positions are absolute, in the card's own 1200x630 pixels: a rendered SVG does not flow,
//! so a line that could be long (a space's name) is shortened here, before it is drawn.
//!
//! Everything a card uses is embedded in the binary (fonts, bee, emoji, avatars, the mark), and the
//! resolver below refuses any other image reference, so rendering never reads the disk or the
//! network, whatever text ends up inside the SVG.

use std::sync::{Arc, OnceLock};

use resvg::tiny_skia;
use resvg::usvg::{self, fontdb, ImageHrefResolver, ImageKind};

use super::text::{self, Texts};
use crate::auth::mail_text::Locale;

pub const WIDTH: u32 = 1200;
pub const HEIGHT: u32 = 630;

// The design tokens the cards use (apps/web/app/tokens.css, day theme).
const BG: &str = "#f6f7f9";
const SURFACE: &str = "#fdfdfe";
const INK: &str = "#15171c";
const BODY: &str = "#2e323a";
const MUTED: &str = "#5a6070";
const LINE: &str = "#e2e5ea";
const LINE_STRONG: &str = "#cfd3da";
const SKY: &str = "#8fd0ff";
const MINT: &str = "#6fe0c2";
const VIOLET: &str = "#c9a8ff";
const PINK: &str = "#f5b0f0";
const PEACH: &str = "#ffb3ba";
const BEE: &str = "#fbbf1a";
const BRAND: &str = "#c65d45";
const ALARM: &str = "#f4522a";
const MINT_INK: &str = "#0c5a47";
const PEACH_INK: &str = "#7a1d27";
/// The personal link warning's fill: the alarm, far lighter, so its dark text keeps its contrast.
const WARNING_BG: &str = "#ffe3d9";

const SANS: &str = "IBM Plex Sans";
const MONO: &str = "IBM Plex Mono";

const BEE_SPRITE: &str = include_str!("../../assets/og/bee.svg");
const MARK_PNG: &[u8] = include_bytes!("../../assets/og/mark.png");
const FONT_SANS_BOLD: &[u8] = include_bytes!("../../assets/og/fonts/IBMPlexSans-Bold.ttf");
const FONT_SANS_MEDIUM: &[u8] = include_bytes!("../../assets/og/fonts/IBMPlexSans-Medium.ttf");
const FONT_MONO_MEDIUM: &[u8] = include_bytes!("../../assets/og/fonts/IBMPlexMono-Medium.ttf");

/// The embedded images a card may reference, by the name used in its `href`.
fn embedded_svg(name: &str) -> Option<&'static str> {
    Some(match name {
        "emoji/lock" => include_str!("../../assets/og/emoji/lock.svg"),
        "emoji/party" => include_str!("../../assets/og/emoji/party.svg"),
        "emoji/thumbs-up" => include_str!("../../assets/og/emoji/thumbs-up.svg"),
        "emoji/heart" => include_str!("../../assets/og/emoji/heart.svg"),
        "avatar/1" => include_str!("../../assets/og/avatars/1.svg"),
        "avatar/2" => include_str!("../../assets/og/avatars/2.svg"),
        "avatar/3" => include_str!("../../assets/og/avatars/3.svg"),
        _ => return None,
    })
}

/// What a card shows. Each variant carries the only data that changes from one card to another.
pub enum Card {
    Home {
        instance: String,
    },
    Invite {
        space: String,
        inviter: Option<String>,
        members: u64,
        channels: u64,
    },
    InviteExpired,
    Message,
    Space,
    Personal {
        path: &'static str,
    },
    Status {
        database: bool,
        cache: bool,
    },
}

/// Draw `card` in `locale` and encode it as PNG.
pub fn render(card: &Card, locale: Locale) -> Result<Vec<u8>, String> {
    let svg = svg(card, locale);
    let options = options();
    let tree = usvg::Tree::from_str(&svg, &options).map_err(|err| err.to_string())?;
    let mut pixmap = tiny_skia::Pixmap::new(WIDTH, HEIGHT).ok_or("pixmap")?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    pixmap.encode_png().map_err(|err| err.to_string())
}

/// The fonts, loaded once: parsing three font files on every card would be most of its cost.
fn fonts() -> Arc<fontdb::Database> {
    static FONTS: OnceLock<Arc<fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = fontdb::Database::new();
            for font in [FONT_SANS_BOLD, FONT_SANS_MEDIUM, FONT_MONO_MEDIUM] {
                db.load_font_data(font.to_vec());
            }
            Arc::new(db)
        })
        .clone()
}

fn options() -> usvg::Options<'static> {
    let mut options = usvg::Options {
        fontdb: fonts(),
        ..usvg::Options::default()
    };
    // Only the embedded images resolve. A `data:` URL or a path is refused, so no text that reached
    // a card (a space's name) can make the renderer load anything.
    options.image_href_resolver = ImageHrefResolver {
        resolve_data: Box::new(|_, _, _| None),
        resolve_string: Box::new(|href: &str, opts: &usvg::Options| {
            let name = href.strip_prefix("og:")?;
            if name == "mark" {
                return Some(ImageKind::PNG(Arc::new(MARK_PNG.to_vec())));
            }
            let tree = usvg::Tree::from_str(embedded_svg(name)?, opts).ok()?;
            Some(ImageKind::SVG(tree))
        }),
    };
    options
}

/// The whole SVG document for `card`.
pub fn svg(card: &Card, locale: Locale) -> String {
    let t = text::texts(locale);
    let body = match card {
        Card::Home { instance } => home(t, instance),
        Card::Invite {
            space,
            inviter,
            members,
            channels,
        } => invite(t, locale, space, inviter.as_deref(), *members, *channels),
        Card::InviteExpired => expired(t),
        Card::Message => message(t),
        Card::Space => space_card(t),
        Card::Personal { path } => personal(t, path),
        Card::Status { database, cache } => status(t, *database, *cache),
    };
    // The sprite's symbols are defined once at the top of the document and used by id below.
    let sprite = BEE_SPRITE
        .split_once('>')
        .and_then(|(_, rest)| rest.rsplit_once("</svg>"))
        .map_or("", |(inner, _)| inner);
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">{sprite}<rect width="{WIDTH}" height="{HEIGHT}" fill="{BG}"/>{body}</svg>"#
    )
}

// --- Drawing helpers --------------------------------------------------------------------------------

/// Escape text for an SVG text node or attribute.
fn esc(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Keep `value` to `max` characters, ending in an ellipsis when it was longer.
fn clip(value: &str, max: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max {
        return value.to_owned();
    }
    let kept: String = value.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// An approximate advance for `value` at `size`: enough to size a pill or place an emoji after a
/// sentence. `ratio` is the face's average advance per em (0.6 for Plex Mono, about 0.55 for Sans).
fn width(value: &str, size: f32, ratio: f32) -> f32 {
    value.chars().count() as f32 * size * ratio
}

fn text(x: f32, y: f32, size: f32, weight: u16, fill: &str, family: &str, content: &str) -> String {
    let spacing = if family == SANS && size >= 30.0 {
        -0.03 * size
    } else {
        0.0
    };
    format!(
        r#"<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" letter-spacing="{spacing}" fill="{fill}">{}</text>"#,
        esc(content)
    )
}

/// The mark and the name, with the terracotta point: `cy` is the vertical middle of the mark.
fn wordmark(x: f32, cy: f32, size: f32) -> String {
    let top = cy - size / 2.0;
    let text_x = x + size * 1.3;
    let baseline = cy + size * 0.36;
    let spacing = -0.03 * size;
    format!(
        r#"<image href="og:mark" x="{x}" y="{top}" width="{size}" height="{size}"/><text x="{text_x}" y="{baseline}" font-family="{SANS}" font-size="{size}" font-weight="700" letter-spacing="{spacing}" fill="{INK}">Ruchoir<tspan fill="{BRAND}">.</tspan></text>"#
    )
}

/// A rounded pastel label, as the design system draws a tag. Returns the SVG and its width.
fn pill(x: f32, y: f32, label: &str, fill: &str) -> (String, f32) {
    let size = 21.0;
    let w = width(label, size, 0.6) + 34.0;
    let svg = format!(
        r#"<rect x="{x}" y="{y}" width="{w}" height="46" rx="23" fill="{fill}" stroke="{INK}" stroke-width="2.5"/>{}"#,
        text(x + 17.0, y + 30.0, size, 500, INK, MONO, label)
    );
    (svg, w)
}

/// The tilted card on the right: its offset shadow, its face, then `inner` in the same frame.
fn tilted(x: f32, y: f32, w: f32, h: f32, shadow: &str, inner: &str) -> String {
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let sx = x + 12.0;
    let sy = y + 12.0;
    format!(
        r#"<g transform="rotate(3 {cx} {cy})"><rect x="{sx}" y="{sy}" width="{w}" height="{h}" rx="22" fill="{shadow}"/><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="22" fill="{SURFACE}" stroke="{INK}" stroke-width="3"/>{inner}</g>"#
    )
}

/// The bee `variant`, `w` wide, its top left corner at (`x`, `y`), turned by `angle` degrees.
fn bee(variant: &str, view_height: f32, x: f32, y: f32, w: f32, angle: f32) -> String {
    let h = w * view_height / 1300.0;
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    format!(
        r##"<g transform="rotate({angle} {cx} {cy})"><use href="#bee-{variant}" x="{x}" y="{y}" width="{w}" height="{h}"/></g>"##
    )
}

fn image(name: &str, x: f32, y: f32, size: f32) -> String {
    format!(r#"<image href="og:{name}" x="{x}" y="{y}" width="{size}" height="{size}"/>"#)
}

/// A square avatar tile with its ink edge: a pastel, or an image clipped to the rounded square.
fn tile(id: &str, x: f32, y: f32, size: f32, fill: &str, picture: Option<&str>) -> String {
    let r = size * 0.27;
    let face = match picture {
        Some(name) => format!(
            r#"<clipPath id="{id}"><rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{r}"/></clipPath><g clip-path="url(#{id})">{}</g>"#,
            image(name, x, y, size)
        ),
        None => String::new(),
    };
    format!(
        r#"<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{r}" fill="{fill}"/>{face}<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{r}" fill="none" stroke="{INK}" stroke-width="2.5"/>"#
    )
}

/// A grey bar standing for text nobody should read on the card.
fn bar(x: f32, y: f32, w: f32, h: f32, fill: &str) -> String {
    let r = h / 2.0;
    format!(r#"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"/>"#)
}

/// The left column shared by most cards: the wordmark, an optional small line above the title, the
/// title's lines, and the sentence under it.
fn left(kicker: Option<&str>, title: &[&str], sub: &[&str]) -> String {
    let mut out = wordmark(80.0, 212.0, 64.0);
    let mut y = 305.0;
    if let Some(kicker) = kicker {
        out += &text(80.0, y, 30.0, 500, BODY, SANS, kicker);
        y += 63.0;
    } else {
        y += 33.0;
    }
    for line in title {
        out += &text(80.0, y, 52.0, 700, INK, SANS, line);
        y += 56.0;
    }
    y += 4.0;
    for line in sub {
        out += &text(80.0, y, 28.0, 500, BODY, SANS, line);
        y += 38.0;
    }
    out
}

// --- The cards --------------------------------------------------------------------------------------

fn home(t: &Texts, instance: &str) -> String {
    let mut out = wordmark(80.0, 205.0, 84.0);
    out += &text(80.0, 282.0, 24.0, 500, MUTED, MONO, &clip(instance, 36));
    out += &text(80.0, 346.0, 40.0, 700, INK, SANS, t.home_title[0]);
    out += &text(80.0, 392.0, 40.0, 700, INK, SANS, t.home_title[1]);
    let (first, w) = pill(80.0, 440.0, t.home_tags[0], SKY);
    let (second, _) = pill(80.0 + w + 12.0, 440.0, t.home_tags[1], MINT);
    out += &first;
    out += &second;

    // The conversation on the card, in the instance's language.
    let (x, y, w, h) = (680.0, 62.0, 470.0, 530.0);
    let mut inner = text(
        x + 26.0,
        y + 50.0,
        26.0,
        700,
        INK,
        SANS,
        &format!("# {}", t.demo_channel),
    );
    inner += &format!(
        r#"<rect x="{}" y="{}" width="{}" height="2" fill="{LINE}"/>"#,
        x + 26.0,
        y + 72.0,
        w - 52.0
    );
    let rows: [(&str, &str, f32); 3] = [
        ("Léa", "avatar/1", 96.0),
        ("Hugo", "avatar/2", 178.0),
        ("Inès", "avatar/3", 304.0),
    ];
    for (i, (name, avatar, dy)) in rows.iter().enumerate() {
        let ry = y + dy;
        inner += &tile(
            &format!("home-av-{i}"),
            x + 26.0,
            ry,
            52.0,
            MINT,
            Some(avatar),
        );
        inner += &text(x + 92.0, ry + 18.0, 20.0, 700, INK, SANS, name);
        inner += &text(
            x + 92.0,
            ry + 46.0,
            20.0,
            500,
            BODY,
            SANS,
            t.demo_messages[i],
        );
    }
    // A party popper after the first message, and two reactions under the second.
    let after = x + 92.0 + width(t.demo_messages[0], 20.0, 0.47) + 8.0;
    inner += &image("emoji/party", after, y + 96.0 + 28.0, 22.0);
    let py = y + 178.0 + 62.0;
    inner += &format!(
        r#"<rect x="{}" y="{}" width="66" height="32" rx="16" fill="{INK}"/><rect x="{}" y="{py}" width="66" height="32" rx="16" fill="{SURFACE}" stroke="{INK}" stroke-width="2"/>"#,
        x + 95.0,
        py + 3.0,
        x + 92.0
    );
    inner += &image("emoji/thumbs-up", x + 104.0, py + 6.0, 20.0);
    inner += &text(x + 130.0, py + 23.0, 18.0, 500, INK, SANS, "3");
    inner += &format!(
        r#"<rect x="{}" y="{py}" width="66" height="32" rx="16" fill="{SURFACE}" stroke="{LINE}" stroke-width="2"/>"#,
        x + 168.0
    );
    inner += &image("emoji/heart", x + 180.0, py + 6.0, 20.0);
    inner += &text(x + 206.0, py + 23.0, 18.0, 500, INK, SANS, "2");
    // The composer at the foot, with its sky shadow.
    let (cx, cy, cw) = (x + 26.0, y + h - 88.0, w - 52.0);
    inner += &format!(
        r#"<rect x="{}" y="{}" width="{cw}" height="62" rx="14" fill="{SKY}"/><rect x="{cx}" y="{cy}" width="{cw}" height="62" rx="14" fill="{SURFACE}" stroke="{INK}" stroke-width="2.5"/>"#,
        cx + 5.0,
        cy + 5.0
    );
    inner += &text(
        cx + 18.0,
        cy + 38.0,
        20.0,
        500,
        MUTED,
        SANS,
        t.demo_composer,
    );
    out += &tilted(x, y, w, h, INK, &inner);
    out += &bee("happy", 1200.0, 560.0, 20.0, 150.0, -12.0);
    out
}

fn invite(
    t: &Texts,
    locale: Locale,
    space: &str,
    inviter: Option<&str>,
    members: u64,
    channels: u64,
) -> String {
    let mut out = wordmark(80.0, 212.0, 64.0);
    let inviter = inviter.map(|name| clip(name, 22));
    out += &text(
        80.0,
        305.0,
        30.0,
        500,
        BODY,
        SANS,
        &text::invite_kicker(locale, inviter.as_deref()),
    );
    // A long name is set smaller before it is shortened, so most names show whole. The column ends
    // where the bee starts, about 430 pixels in.
    let name = space.trim();
    let (size, max) = if name.chars().count() <= 15 {
        (54.0, 15)
    } else {
        (40.0, 20)
    };
    out += &text(80.0, 367.0, size, 700, INK, SANS, &clip(name, max));
    let bw = width(t.invite_button, 26.0, 0.56) + 56.0;
    out += &format!(
        r#"<rect x="86" y="416" width="{bw}" height="64" rx="14" fill="{BEE}"/><rect x="80" y="410" width="{bw}" height="64" rx="14" fill="{INK}"/>"#
    );
    out += &text(108.0, 452.0, 26.0, 700, SURFACE, SANS, t.invite_button);

    let (x, y, w, h) = (700.0, 150.0, 430.0, 360.0);
    let initial: String = name
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_default();
    let mut inner = tile("inv-space", x + 26.0, y + 26.0, 64.0, MINT, None);
    inner += &format!(
        r#"<text x="{}" y="{}" text-anchor="middle" font-family="{SANS}" font-size="30" font-weight="700" fill="{INK}">{}</text>"#,
        x + 58.0,
        y + 69.0,
        esc(&initial)
    );
    inner += &text(x + 106.0, y + 54.0, 24.0, 700, INK, SANS, &clip(name, 18));
    inner += &text(
        x + 106.0,
        y + 82.0,
        17.0,
        500,
        MUTED,
        MONO,
        &text::space_counts(locale, members, channels),
    );
    inner += &format!(
        r#"<rect x="{}" y="{}" width="{}" height="2" fill="{LINE}"/>"#,
        x + 26.0,
        y + 112.0,
        w - 52.0
    );
    // Channels drawn as bars, never by name: the card is public, some channels are not.
    for (i, bw) in [150.0, 110.0, 170.0].iter().enumerate() {
        let ry = y + 140.0 + i as f32 * 42.0;
        inner += &text(x + 26.0, ry + 14.0, 20.0, 700, MUTED, SANS, "#");
        inner += &bar(x + 50.0, ry, *bw, 14.0, LINE);
    }
    for (i, avatar) in ["avatar/1", "avatar/2", "avatar/3"].iter().enumerate() {
        inner += &tile(
            &format!("inv-av-{i}"),
            x + 26.0 + i as f32 * 34.0,
            y + h - 72.0,
            46.0,
            SURFACE,
            Some(avatar),
        );
    }
    if members > 3 {
        inner += &text(
            x + 146.0,
            y + h - 42.0,
            18.0,
            500,
            MUTED,
            MONO,
            &format!("+{}", members - 3),
        );
    }
    out += &tilted(x, y, w, h, INK, &inner);
    out += &bee("key", 1700.0, 510.0, 120.0, 210.0, -8.0);
    out
}

fn expired(t: &Texts) -> String {
    let mut out = left(Some(t.expired_kicker), &[t.expired_title], &t.expired_sub);
    let (x, y, w, h) = (700.0, 150.0, 430.0, 350.0);
    let mut inner = format!(
        r#"<g opacity="0.5">{}"#,
        tile("exp-t", x + 26.0, y + 26.0, 64.0, LINE, None)
    );
    inner += &bar(x + 106.0, y + 40.0, 175.0, 18.0, LINE_STRONG);
    inner += &bar(x + 106.0, y + 70.0, 115.0, 14.0, LINE);
    inner += "</g>";
    inner += &format!(
        r#"<rect x="{}" y="{}" width="{}" height="2" fill="{LINE}"/>"#,
        x + 26.0,
        y + 112.0,
        w - 52.0
    );
    for (i, bw) in [260.0, 205.0, 230.0].iter().enumerate() {
        inner += &bar(x + 26.0, y + 140.0 + i as f32 * 32.0, *bw, 16.0, LINE);
    }
    // The stamp, turned the other way from the card.
    let stamp_w = width(t.expired_stamp, 30.0, 0.6) + 40.0;
    let (sx, sy) = (x + w - 30.0 - stamp_w, y + h - 100.0);
    out += &tilted(
        x,
        y,
        w,
        h,
        LINE,
        &format!(
            r#"{inner}<g transform="rotate(-10 {} {})"><rect x="{sx}" y="{sy}" width="{stamp_w}" height="60" rx="12" fill="none" stroke="{BRAND}" stroke-width="4"/>{}</g>"#,
            sx + stamp_w / 2.0,
            sy + 30.0,
            text(
                sx + 20.0,
                sy + 41.0,
                30.0,
                500,
                BRAND,
                MONO,
                t.expired_stamp
            )
        ),
    );
    out += &bee("asleep", 1200.0, 520.0, 170.0, 200.0, -4.0);
    out
}

/// The rows of a conversation drawn as bars: a pastel square for each author, grey lines for text.
fn blurred_rows(x: f32, y: f32, colors: [&str; 3]) -> String {
    let mut out = String::new();
    for (i, (color, (a, b))) in colors
        .iter()
        .zip([(160.0, 250.0), (95.0, 190.0), (130.0, 225.0)])
        .enumerate()
    {
        let ry = y + i as f32 * 74.0;
        out += &tile(&format!("row-{i}"), x, ry, 52.0, color, None);
        out += &bar(x + 66.0, ry + 4.0, a, 16.0, LINE_STRONG);
        out += &bar(x + 66.0, ry + 32.0, b, 14.0, LINE);
    }
    out
}

fn lock_header(x: f32, y: f32, w: f32) -> String {
    let mut out = image("emoji/lock", x, y + 22.0, 28.0);
    out += &bar(x + 38.0, y + 28.0, 190.0, 18.0, LINE_STRONG);
    out += &format!(
        r#"<rect x="{x}" y="{}" width="{w}" height="2" fill="{LINE}"/>"#,
        y + 70.0
    );
    out
}

fn message(t: &Texts) -> String {
    let mut out = left(None, &t.message_title, &[t.message_sub]);
    let (x, y, w, h) = (700.0, 150.0, 430.0, 350.0);
    let mut inner = lock_header(x + 26.0, y + 4.0, w - 52.0);
    inner += &blurred_rows(x + 26.0, y + 94.0, [PINK, MINT, VIOLET]);
    out += &tilted(x, y, w, h, INK, &inner);
    out += &bee("letter", 1640.0, 490.0, 130.0, 230.0, -8.0);
    out
}

fn space_card(t: &Texts) -> String {
    let mut out = left(None, &t.space_title, &[t.space_sub]);
    let (x, y, w, h) = (700.0, 150.0, 430.0, 350.0);
    // The rail of spaces down the left edge, clipped to the card's rounded corners.
    let mut inner = format!(
        r#"<clipPath id="space-card"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="22"/></clipPath><g clip-path="url(#space-card)"><rect x="{x}" y="{y}" width="84" height="{h}" fill="{BG}"/><rect x="{}" y="{y}" width="2" height="{h}" fill="{LINE}"/></g>"#,
        x + 84.0
    );
    for (i, color) in [MINT, SKY, PEACH].iter().enumerate() {
        let ty = y + 22.0 + i as f32 * 58.0;
        if i == 0 {
            inner += &format!(
                r#"<rect x="{}" y="{}" width="46" height="46" rx="12" fill="{INK}"/>"#,
                x + 21.0,
                ty + 4.0
            );
        }
        inner += &format!(
            r#"<g opacity="{}">{}</g>"#,
            if i == 0 { 1.0 } else { 0.7 },
            tile(&format!("rail-{i}"), x + 17.0, ty, 46.0, color, None)
        );
    }
    inner += &lock_header(x + 110.0, y, w - 134.0);
    for (i, bw) in [160.0, 115.0, 180.0, 100.0, 140.0].iter().enumerate() {
        let ry = y + 96.0 + i as f32 * 42.0;
        inner += &text(x + 110.0, ry + 14.0, 20.0, 700, MUTED, SANS, "#");
        inner += &bar(
            x + 134.0,
            ry,
            *bw,
            14.0,
            if i == 0 { LINE_STRONG } else { LINE },
        );
    }
    out += &tilted(x, y, w, h, MINT, &inner);
    out += &bee("comb", 1720.0, 485.0, 105.0, 240.0, -8.0);
    out
}

fn personal(t: &Texts, path: &str) -> String {
    let mut out = left(
        Some(t.personal_kicker),
        &[t.personal_title],
        &t.personal_sub,
    );
    let (x, y, w, h) = (700.0, 150.0, 430.0, 350.0);
    let mut inner = image("emoji/lock", x + 26.0, y + 24.0, 30.0);
    inner += &text(x + 68.0, y + 48.0, 24.0, 700, INK, SANS, t.personal_card);
    inner += &format!(
        r#"<rect x="{}" y="{}" width="{}" height="2" fill="{LINE}"/>"#,
        x + 26.0,
        y + 76.0,
        w - 52.0
    );
    inner += &text(x + 26.0, y + 122.0, 20.0, 500, MUTED, MONO, path);
    inner += &text(
        x + 26.0,
        y + 152.0,
        20.0,
        500,
        MUTED,
        MONO,
        "?token=••••••••••",
    );
    let (bx, by, bw) = (x + 26.0, y + h - 126.0, w - 52.0);
    inner += &format!(
        r##"<rect x="{bx}" y="{by}" width="{bw}" height="100" rx="14" fill="{WARNING_BG}" stroke="{INK}" stroke-width="2.5"/>"##
    );
    inner += &text(
        bx + 20.0,
        by + 42.0,
        20.0,
        700,
        PEACH_INK,
        SANS,
        t.personal_warning[0],
    );
    inner += &text(
        bx + 20.0,
        by + 70.0,
        20.0,
        700,
        PEACH_INK,
        SANS,
        t.personal_warning[1],
    );
    out += &tilted(x, y, w, h, ALARM, &inner);
    out += &bee("alert", 1200.0, 505.0, 150.0, 210.0, -6.0);
    out
}

fn status(t: &Texts, database: bool, cache: bool) -> String {
    let ok = database && cache;
    let (title, sub) = if ok {
        (t.status_ok_title, &t.status_ok_sub)
    } else {
        (t.status_ko_title, &t.status_ko_sub)
    };
    let mut out = left(Some(t.status_kicker), &[title], sub);
    let (x, y, w, h) = (700.0, 150.0, 430.0, 350.0);
    let mut inner = text(x + 26.0, y + 48.0, 24.0, 700, INK, SANS, t.status_card);
    inner += &format!(
        r#"<rect x="{}" y="{}" width="{}" height="2" fill="{LINE}"/>"#,
        x + 26.0,
        y + 72.0,
        w - 52.0
    );
    // The server answered, or there would be no card: it is always up here.
    for (i, (label, up)) in t
        .status_rows
        .iter()
        .zip([true, database, cache])
        .enumerate()
    {
        let ry = y + 118.0 + i as f32 * 48.0;
        inner += &text(x + 26.0, ry, 21.0, 500, INK, SANS, label);
        let word = if up { t.status_ok } else { t.status_ko };
        let right = x + w - 26.0;
        let (dot, ink) = if up {
            (MINT, MINT_INK)
        } else {
            (ALARM, PEACH_INK)
        };
        let dx = right - width(word, 17.0, 0.6) - 16.0;
        inner += &format!(
            r#"<circle cx="{dx}" cy="{}" r="7" fill="{dot}" stroke="{INK}" stroke-width="2"/><text x="{right}" y="{ry}" text-anchor="end" font-family="{MONO}" font-size="17" font-weight="500" fill="{ink}">{}</text>"#,
            ry - 6.0,
            esc(word)
        );
    }
    out += &tilted(x, y, w, h, if ok { MINT } else { ALARM }, &inner);
    out += &if ok {
        bee("happy", 1200.0, 520.0, 130.0, 190.0, -10.0)
    } else {
        bee("alert", 1200.0, 510.0, 140.0, 200.0, -6.0)
    };
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_card() -> Vec<Card> {
        vec![
            Card::Home {
                instance: "chat.example.org".into(),
            },
            Card::Invite {
                space: "Atelier de développement & co <b>".into(),
                inviter: Some("Théo".into()),
                members: 12,
                channels: 8,
            },
            Card::Invite {
                space: "A".into(),
                inviter: None,
                members: 1,
                channels: 1,
            },
            Card::InviteExpired,
            Card::Message,
            Card::Space,
            Card::Personal {
                path: "/reset-password",
            },
            Card::Status {
                database: true,
                cache: true,
            },
            Card::Status {
                database: false,
                cache: true,
            },
        ]
    }

    fn card_name(card: &Card) -> String {
        match card {
            Card::Home { .. } => "home".into(),
            Card::Invite { inviter, .. } => format!("invite-{}", inviter.is_some()),
            Card::InviteExpired => "expired".into(),
            Card::Message => "message".into(),
            Card::Space => "space".into(),
            Card::Personal { .. } => "personal".into(),
            Card::Status { database, .. } => format!("status-{database}"),
        }
    }

    #[test]
    fn every_card_renders_to_a_png_of_the_expected_size_in_every_language() {
        for locale in [
            Locale::Fr,
            Locale::En,
            Locale::Es,
            Locale::De,
            Locale::It,
            Locale::Pl,
        ] {
            for card in every_card() {
                let png = render(&card, locale).expect("card renders");
                // `RUCHOIR_OG_DUMP=<dir>` writes every card out, to look at them after a change.
                if let Ok(dir) = std::env::var("RUCHOIR_OG_DUMP") {
                    let name = format!("{dir}/{}-{}.png", locale.as_str(), card_name(&card));
                    std::fs::write(name, &png).expect("dump card");
                }
                assert_eq!(&png[1..4], b"PNG");
                // Width and height, big-endian, in the IHDR chunk.
                assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), WIDTH);
                assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), HEIGHT);
            }
        }
    }

    #[test]
    fn names_are_escaped_and_shortened() {
        let svg = svg(
            &Card::Invite {
                space: "<script>&".into(),
                inviter: Some("A very long display name that goes on".into()),
                members: 2,
                channels: 0,
            },
            Locale::En,
        );
        assert!(svg.contains("&lt;script&gt;&amp;"));
        assert!(!svg.contains("<script>"));
        assert!(svg.contains("A very long display n…"));
    }

    #[test]
    fn only_embedded_images_resolve() {
        let options = options();
        let resolve = &options.image_href_resolver.resolve_string;
        assert!(resolve("og:mark", &options).is_some());
        assert!(resolve("og:emoji/lock", &options).is_some());
        assert!(resolve("/etc/passwd", &options).is_none());
        assert!(resolve("og:../../etc/passwd", &options).is_none());
        assert!(resolve("https://example.org/a.png", &options).is_none());
    }
}
