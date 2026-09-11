//! Mention extraction from a message body.
//!
//! Mentions are parsed server-side at send time and resolved to stable user ids in
//! `message_mentions`, which later drives notifications. Parsing is intentionally split from
//! resolution: [`extract_mention_tokens`] is a pure, unit-tested scan of the raw markdown, and
//! [`resolve_mentions`] maps the resulting tokens onto real accounts against the database.
//!
//! Grammar (MVP): `@here` and `@channel` are the two broadcast tokens; anything else of the form
//! `@handle` (letters, digits, `.`, `_`, `-`) is a candidate user mention. A handle resolves when it
//! matches, accent- and case-insensitively, any whitespace token of a member's display name (so
//! `@yanis` reaches "Yanis Berthier") or the whole name with spaces removed. An `@` that is not at a
//! word boundary (e.g. inside `user@host`) is ignored, so email addresses never register as mentions.
//! Ambiguous or unmatched handles are left as plain text and simply not stored. Richer, unambiguous
//! mention tokens (id-backed) can layer on later without changing the storage shape.

use std::collections::BTreeSet;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

use super::error::ApiError;
use crate::entities::users;

/// The distinct mention tokens found in a body.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MentionTokens {
    /// Lowercased candidate user handles, de-duplicated.
    pub users: BTreeSet<String>,
    /// Whether `@here` appeared.
    pub here: bool,
    /// Whether `@channel` appeared.
    pub channel: bool,
}

impl MentionTokens {
    /// Whether nothing mentionable was found.
    pub fn is_empty(&self) -> bool {
        self.users.is_empty() && !self.here && !self.channel
    }
}

/// Scan a raw message body for mention tokens. Pure and allocation-light; no I/O.
pub fn extract_mention_tokens(body: &str) -> MentionTokens {
    let mut tokens = MentionTokens::default();
    // Scanned by character rather than by byte, because names are not ASCII. Byte scanning ended a
    // handle at the first accented letter, so `@Théo` was read as `@Th` and reached nobody: the
    // message sent, the mention was never recorded, and there was nothing anywhere to say why. The
    // fold to ASCII happens below, against the name, which is where it belongs.
    let chars: Vec<(usize, char)> = body.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1 != '@' {
            i += 1;
            continue;
        }
        // A mention starts at the beginning of the body or after a non-word character, so that
        // `user@host` (an email) never triggers one.
        let at_boundary = i == 0 || !is_handle_char(chars[i - 1].1);
        if !at_boundary {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while end < chars.len() && is_handle_char(chars[end].1) {
            end += 1;
        }
        if end == start {
            i += 1;
            continue;
        }
        let from = chars[start].0;
        let to = chars.get(end).map_or(body.len(), |(at, _)| *at);
        // Trailing `.`/`-`/`_` are punctuation (e.g. the period ending a sentence), not part of the
        // handle; interior ones are kept so `first.last` handles survive.
        let handle = body[from..to].trim_end_matches(['.', '-', '_']);
        if handle.is_empty() {
            i = end;
            continue;
        }
        // Folded here so the set holds one spelling per handle: `@Théo`, `@theo` and `@THEO` are
        // the same mention, and the members are compared in the same folded form.
        match fold_ascii(handle).as_str() {
            "here" => tokens.here = true,
            "channel" | "everyone" | "all" => tokens.channel = true,
            other => {
                tokens.users.insert(other.to_string());
            }
        }
        i = end;
    }
    tokens
}

/// One resolved mention destined for `message_mentions`.
pub struct ResolvedMention {
    pub user_id: Uuid,
    /// One of `user`, `here`, `channel`.
    pub mention_type: &'static str,
}

/// Resolve tokens to concrete `message_mentions` rows against `audience` (the conversation's
/// members). User handles are matched case-insensitively on `display_name` within the audience;
/// ambiguous handles (more than one match) are dropped. `@here`/`@channel` expand to one row per
/// audience member (excluding the author), so downstream notification logic is a plain lookup.
pub async fn resolve_mentions(
    db: &DatabaseConnection,
    author_id: Uuid,
    audience: &[Uuid],
    tokens: &MentionTokens,
) -> Result<Vec<ResolvedMention>, ApiError> {
    if tokens.is_empty() || audience.is_empty() {
        return Ok(Vec::new());
    }

    let members = users::Entity::find()
        .filter(users::Column::Id.is_in(audience.iter().copied()))
        .all(db)
        .await?;

    let mut resolved: Vec<ResolvedMention> = Vec::new();
    let mut seen: BTreeSet<Uuid> = BTreeSet::new();

    // Broadcast mentions: one row per other member, typed so notifications can distinguish them.
    if tokens.here || tokens.channel {
        let mention_type = if tokens.channel { "channel" } else { "here" };
        for member in &members {
            if member.id != author_id && seen.insert(member.id) {
                resolved.push(ResolvedMention {
                    user_id: member.id,
                    mention_type,
                });
            }
        }
    }

    // User handles: unambiguous, accent- and case-insensitive matches within the audience. A handle
    // matches a member if it equals any whitespace token of their display name (so `@yanis` reaches
    // "Yanis Berthier") or the whole name with spaces removed (`@yanisberthier`). Ambiguous handles
    // (more than one member) are dropped, so `@yanis` with two Yanises resolves to nobody.
    for handle in &tokens.users {
        let matches: Vec<&users::Model> = members
            .iter()
            .filter(|m| display_name_matches(&m.display_name, handle))
            .collect();
        if let [only] = matches.as_slice() {
            if seen.insert(only.id) {
                resolved.push(ResolvedMention {
                    user_id: only.id,
                    mention_type: "user",
                });
            } else if let Some(existing) = resolved.iter_mut().find(|r| r.user_id == only.id) {
                // A direct @user mention is more specific than a broadcast one.
                existing.mention_type = "user";
            }
        }
    }

    Ok(resolved)
}

/// Whether a character may appear inside a mention handle: any letter or digit, plus `.`, `_`, `-`.
///
/// Deliberately not restricted to ASCII. A handle is typed by a person reading a name, and names
/// carry accents; stopping at the first one silently truncated the handle to something that matched
/// nobody.
fn is_handle_char(c: char) -> bool {
    c.is_alphanumeric() || c == '.' || c == '_' || c == '-'
}

/// Whether an (already folded) handle addresses a member: it equals one of the display name's
/// whitespace tokens, or the whole name with spaces removed. Both sides are folded the same way, so
/// `@leveque` and `@Lévêque` both reach "Lévêque".
fn display_name_matches(display_name: &str, handle: &str) -> bool {
    display_name
        .split_whitespace()
        .any(|token| fold_ascii(token) == handle)
        || fold_ascii(&display_name.split_whitespace().collect::<String>()) == handle
}

/// Lowercase and strip common Latin diacritics so an ASCII handle can match an accented name.
fn fold_ascii(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        for lc in ch.to_lowercase() {
            match lc {
                'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => out.push('a'),
                'æ' => out.push_str("ae"),
                'ç' => out.push('c'),
                'è' | 'é' | 'ê' | 'ë' => out.push('e'),
                'ì' | 'í' | 'î' | 'ï' => out.push('i'),
                'ñ' => out.push('n'),
                'ò' | 'ó' | 'ô' | 'õ' | 'ö' => out.push('o'),
                'œ' => out.push_str("oe"),
                'ù' | 'ú' | 'û' | 'ü' => out.push('u'),
                'ý' | 'ÿ' => out.push('y'),
                other => out.push(other),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_accented_handle_survives_the_scan() {
        // The defect this guards: byte scanning ended the handle at the accent, so the message
        // carried `@Théo` and the server looked for "Th".
        let t = extract_mention_tokens("merci @Théo pour la relecture");
        assert!(t.users.contains("theo"), "got {:?}", t.users);
    }

    #[test]
    fn a_handle_is_one_token_however_it_is_spelled() {
        // Case and accents fold to a single spelling, so the same person is mentioned once.
        let t = extract_mention_tokens("@Théo @theo @THEO");
        assert_eq!(t.users.len(), 1);
        assert!(t.users.contains("theo"));
    }

    #[test]
    fn a_name_inserted_whole_still_addresses_its_owner() {
        // What the composer writes when someone picks a suggestion: the display name verbatim. The
        // handle is its first token, which the resolver matches against the name's tokens.
        let t = extract_mention_tokens("@Théo Vilain peux-tu regarder ?");
        assert!(t.users.contains("theo"));
    }

    #[test]
    fn plain_user_mention() {
        let t = extract_mention_tokens("hey @alice can you look?");
        assert!(t.users.contains("alice"));
        assert!(!t.here && !t.channel);
    }

    #[test]
    fn broadcast_tokens() {
        let t = extract_mention_tokens("@here and @channel please");
        assert!(t.here && t.channel);
        assert!(t.users.is_empty());
    }

    #[test]
    fn email_is_not_a_mention() {
        let t = extract_mention_tokens("write to bob@example.org today");
        assert!(t.is_empty());
    }

    #[test]
    fn case_insensitive_and_deduped() {
        let t = extract_mention_tokens("@Alice @alice @ALICE");
        assert_eq!(t.users.len(), 1);
        assert!(t.users.contains("alice"));
    }

    #[test]
    fn mention_at_start_and_punctuation_boundary() {
        let t = extract_mention_tokens("@carol, ping @dave.");
        assert!(t.users.contains("carol"));
        assert!(t.users.contains("dave"));
    }

    #[test]
    fn bare_at_is_ignored() {
        let t = extract_mention_tokens("email me @ 5pm @");
        assert!(t.is_empty());
    }

    #[test]
    fn handle_matches_first_name_token() {
        // The common case: `@yanis` addresses "Yanis Berthier".
        assert!(display_name_matches("Yanis Berthier", "yanis"));
        assert!(display_name_matches("Yanis Berthier", "berthier"));
        assert!(display_name_matches("Yanis Berthier", "yanisberthier"));
        assert!(!display_name_matches("Yanis Berthier", "yan"));
    }

    #[test]
    fn handle_matching_folds_accents() {
        assert!(display_name_matches("Marc Lévêque", "leveque"));
        assert!(display_name_matches("Sofía Nadir", "sofia"));
        assert!(display_name_matches("Chloé", "chloe"));
    }

    #[test]
    fn fold_ascii_expands_ligatures() {
        assert_eq!(fold_ascii("Cœur"), "coeur");
        assert_eq!(fold_ascii("ÉÈÊ"), "eee");
    }
}
