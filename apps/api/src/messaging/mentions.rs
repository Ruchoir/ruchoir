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

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, QueryFilter,
    Statement,
};
use uuid::Uuid;

use super::error::ApiError;
use crate::entities::users;
use crate::permissions::catalogue::Permission;
use crate::permissions::check::space_rights;

/// The words that address the people connected now, folded (see [`fold_ascii`]): what the clients
/// show in each interface language (`kindBroadcasts`: `@here`, `@ici`, `@hier`, `@aquí`, `@qui`,
/// `@tutaj`). Adding a language to the clients means adding its words here.
pub(crate) const HERE_HANDLES: [&str; 6] = ["here", "ici", "hier", "aqui", "qui", "tutaj"];

/// The words that address the whole room, folded: `@channel`, `@canal` (fr, es), `@Kanal` (de, pl),
/// `@canale` (it), and the older `@everyone`, `@all`, `@tous` the clients still recognise.
pub(crate) const CHANNEL_HANDLES: [&str; 7] = [
    "channel", "everyone", "all", "canal", "tous", "kanal", "canale",
];

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
        // Every interface language, because a reader writes the word the clients show them
        // (`@canal`, `@Kanal`, `@aquí`, `@canale`, `@kanał`), and a right enforced for one spelling
        // only is a right anyone can walk around by changing language.
        match fold_ascii(handle).as_str() {
            h if HERE_HANDLES.contains(&h) => tokens.here = true,
            h if CHANNEL_HANDLES.contains(&h) => tokens.channel = true,
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
    /// One of `user`, `here`, `channel`, `group`.
    pub mention_type: &'static str,
}

/// Resolve a message to concrete `message_mentions` rows against `audience` (the conversation's
/// members).
///
/// Two ways to address someone, because there are two ways people write it. A handle is one word
/// (`@theo`, `@Théo`, `@ThéoVilain`), matched against the tokens of each display name; ambiguous
/// ones, matching more than one member, are dropped rather than guessed at. And an `@` followed by
/// a member's **whole** display name addresses that member, spaces and all, which is what the
/// composer writes when someone picks a suggestion and what a person types when they read a name
/// on screen. The second is why `body` is needed here and not only its tokens: "Théo Vilain" is not
/// a token, and reducing it to its first word is exactly what fails the day two people share it.
///
/// `@here`/`@channel` expand to one row per audience member (excluding the author), so downstream
/// notification logic is a plain lookup.
pub async fn resolve_mentions(
    db: &DatabaseConnection,
    author_id: Uuid,
    audience: &[Uuid],
    body: &str,
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

    // Whole display names first, since they are the most specific thing anyone can write: `@Théo
    // Vilain` names one person even in a space holding two Théos, where the handle `@théo` names
    // nobody on purpose.
    for member in &members {
        if member.id == author_id || !full_name_mentioned(body, &member.display_name) {
            continue;
        }
        if seen.insert(member.id) {
            resolved.push(ResolvedMention {
                user_id: member.id,
                mention_type: "user",
            });
        } else if let Some(existing) = resolved.iter_mut().find(|r| r.user_id == member.id) {
            existing.mention_type = "user";
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

/// Whether this kind of mention names the person (a handle, their name, their group) rather than
/// the room: only those notify as a mention, a broadcast one being the quiet kind.
pub fn is_personal(mention_type: &str) -> bool {
    matches!(mention_type, "user" | "group")
}

/// Resolve the groups a message names (`@Comptabilité`) to their members, as `group` mentions.
///
/// Nothing unless the author holds `members.view` in the space, so a guest cannot use a group name
/// to learn what groups exist or to reach people they have no standing to address. A group is
/// named the way a person is by their whole name: an `@` followed by its name, case and accents
/// ignored, one word or several. Only groups of this space count, and only their members who are in
/// `audience` (those who can read the conversation) are returned, never the author.
pub async fn resolve_group_mentions(
    db: &DatabaseConnection,
    space_id: Uuid,
    author_id: Uuid,
    audience: &[Uuid],
    body: &str,
) -> Result<Vec<ResolvedMention>, ApiError> {
    if !body.contains('@') || audience.is_empty() {
        return Ok(Vec::new());
    }
    // One query for every group of the space with its members; a group with none has one row of
    // NULL.
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT g.id, g.name::text AS name, gm.user_id \
               FROM space_groups g \
               LEFT JOIN space_group_members gm ON gm.group_id = g.id \
              WHERE g.space_id = $1",
            [space_id.into()],
        ))
        .await?;
    let mut groups: BTreeMap<Uuid, (String, Vec<Uuid>)> = BTreeMap::new();
    for row in rows {
        let id: Uuid = row.try_get("", "id")?;
        let name: String = row.try_get("", "name")?;
        let user: Option<Uuid> = row.try_get("", "user_id")?;
        let entry = groups.entry(id).or_insert_with(|| (name, Vec::new()));
        entry.1.extend(user);
    }
    let named: Vec<&(String, Vec<Uuid>)> = groups
        .values()
        .filter(|(name, _)| whole_name_mentioned(body, name))
        .collect();
    if named.is_empty() {
        return Ok(Vec::new());
    }
    if !space_rights(db, space_id, author_id)
        .await?
        .contains(Permission::MembersView)
    {
        return Ok(Vec::new());
    }
    let mut reached: BTreeSet<Uuid> = BTreeSet::new();
    for (_, members) in named {
        for member in members {
            if *member != author_id && audience.contains(member) {
                reached.insert(*member);
            }
        }
    }
    Ok(reached
        .into_iter()
        .map(|user_id| ResolvedMention {
            user_id,
            mention_type: "group",
        })
        .collect())
}

/// Fold `groups` into `resolved`: someone already named directly stays `user`, someone reached by
/// a broadcast becomes `group` (a name outranks the room), anyone else is added.
pub fn merge_group_mentions(resolved: &mut Vec<ResolvedMention>, groups: Vec<ResolvedMention>) {
    for group in groups {
        match resolved.iter_mut().find(|r| r.user_id == group.user_id) {
            Some(existing) if existing.mention_type == "user" => {}
            Some(existing) => existing.mention_type = "group",
            None => resolved.push(group),
        }
    }
}

/// Whether `body` contains an `@` followed by this display name, spaces and all.
///
/// Compared word by word after folding both sides, so accents and case do not matter and the
/// spacing in the message need not match the spacing in the name. The word after the name is left
/// alone: only as many words as the name holds are consumed, and trailing punctuation on the last
/// of them is ignored, so "@Théo Vilain, peux-tu" still names him.
fn full_name_mentioned(body: &str, display_name: &str) -> bool {
    let wanted: Vec<String> = display_name
        .split_whitespace()
        .map(fold_ascii)
        .filter(|w| !w.is_empty())
        .collect();
    // One word is a handle, and the handle pass below already covers it.
    if wanted.len() < 2 {
        return false;
    }
    whole_name_mentioned(body, display_name)
}

/// [`full_name_mentioned`] without the one-word exception: a group's name is not a handle, so
/// `@Comptabilité` names it just as `@Équipe Compta` does.
fn whole_name_mentioned(body: &str, name: &str) -> bool {
    let wanted: Vec<String> = name
        .split_whitespace()
        .map(fold_ascii)
        .filter(|w| !w.is_empty())
        .collect();
    if wanted.is_empty() {
        return false;
    }

    let chars: Vec<(usize, char)> = body.char_indices().collect();
    for i in 0..chars.len() {
        if chars[i].1 != '@' {
            continue;
        }
        if i > 0 && is_handle_char(chars[i - 1].1) {
            continue;
        }
        let after = &body[chars[i].0 + '@'.len_utf8()..];
        let found: Vec<String> = after
            .split_whitespace()
            .take(wanted.len())
            .map(|word| fold_ascii(word.trim_end_matches(['.', ',', ';', ':', '!', '?'])))
            .collect();
        if found == wanted {
            return true;
        }
    }
    false
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
pub(crate) fn fold_ascii(s: &str) -> String {
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
                'ł' => out.push('l'),
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
    fn a_whole_display_name_addresses_its_owner() {
        assert!(full_name_mentioned(
            "merci @Théo Vilain pour la relecture",
            "Théo Vilain"
        ));
        // Case, accents and the spacing of the message do not have to match the stored name.
        assert!(full_name_mentioned("@theo  vilain ?", "Théo Vilain"));
        // Trailing punctuation belongs to the sentence, not to the name.
        assert!(full_name_mentioned(
            "@Théo Vilain, peux-tu regarder ?",
            "Théo Vilain"
        ));
    }

    #[test]
    fn a_whole_name_does_not_address_someone_else() {
        assert!(!full_name_mentioned(
            "@Théo Martin a répondu",
            "Théo Vilain"
        ));
        assert!(!full_name_mentioned(
            "theo vilain sans arobase",
            "Théo Vilain"
        ));
        // An address is not a mention, here as everywhere else.
        assert!(!full_name_mentioned(
            "ecrire a theo@Théo Vilain",
            "Théo Vilain"
        ));
    }

    #[test]
    fn a_group_name_with_spaces_is_mentioned_whole() {
        assert!(whole_name_mentioned(
            "@equipe compta, merci",
            "Équipe Compta"
        ));
        assert!(whole_name_mentioned("ping @Comptabilité !", "Comptabilité"));
        assert!(!whole_name_mentioned("@Equipe seule", "Équipe Compta"));
        assert!(!whole_name_mentioned(
            "Comptabilité sans arobase",
            "Comptabilité"
        ));
        assert!(!whole_name_mentioned("@Comptabilités", "Comptabilité"));
    }

    #[test]
    fn a_group_mention_never_downgrades_a_name_and_outranks_a_broadcast() {
        let id = |n: u128| Uuid::from_u128(n);
        let mk = |u, t| ResolvedMention {
            user_id: id(u),
            mention_type: t,
        };
        let mut resolved = vec![mk(1, "user"), mk(2, "channel")];
        merge_group_mentions(
            &mut resolved,
            vec![mk(1, "group"), mk(2, "group"), mk(3, "group")],
        );
        let types: Vec<(u128, &str)> = resolved
            .iter()
            .map(|r| (r.user_id.as_u128(), r.mention_type))
            .collect();
        assert_eq!(types, vec![(1, "user"), (2, "group"), (3, "group")]);
        assert!(is_personal("group") && is_personal("user") && !is_personal("here"));
    }

    #[test]
    fn a_one_word_name_is_left_to_the_handle_pass() {
        assert!(!full_name_mentioned("@alice bonjour", "alice"));
    }

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
    fn broadcast_tokens_are_recognised_in_french_too() {
        assert!(extract_mention_tokens("@canal on se voit demain").channel);
        assert!(extract_mention_tokens("@tous bonjour").channel);
        assert!(extract_mention_tokens("@ici quelqu'un ?").here);
        // Accents and case fold like any other handle.
        assert!(extract_mention_tokens("@ICI").here);
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

    /// The words the clients tell people to write for the whole room and for the people connected,
    /// in each interface language (the dictionaries' `kindBroadcasts`), as people type them: case,
    /// accents or none.
    const OFFERED: [(&str, &[&str], &[&str]); 6] = [
        ("en", &["@channel", "@Channel"], &["@here", "@HERE"]),
        ("fr", &["@canal", "@Canal"], &["@ici", "@ICI"]),
        ("de", &["@Kanal", "@kanal"], &["@hier", "@Hier"]),
        ("es", &["@canal", "@Canal"], &["@aquí", "@aqui"]),
        ("it", &["@canale", "@Canale"], &["@qui", "@Qui"]),
        ("pl", &["@kanał", "@Kanał", "@kanal"], &["@tutaj", "@Tutaj"]),
    ];

    #[test]
    fn the_room_wide_handles_are_recognised_in_every_interface_language() {
        for (language, channel, here) in OFFERED {
            for handle in channel {
                let tokens = extract_mention_tokens(&format!("{handle} hello"));
                assert!(tokens.channel, "{language}: {handle} is the whole room");
                assert!(tokens.users.is_empty(), "{language}: {handle}");
            }
            for handle in here {
                let tokens = extract_mention_tokens(&format!("{handle} hello"));
                assert!(tokens.here, "{language}: {handle} is the people connected");
                assert!(tokens.users.is_empty(), "{language}: {handle}");
            }
        }
    }

    #[test]
    fn fold_ascii_expands_ligatures() {
        assert_eq!(fold_ascii("Cœur"), "coeur");
        assert_eq!(fold_ascii("ÉÈÊ"), "eee");
    }
}
