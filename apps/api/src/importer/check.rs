//! The contract, enforced before anything is written.
//!
//! This is the Rust side of `packages/importer/validate-archive.py`: the same rules, applied to an
//! archive an administrator hands us rather than to one our own tooling just produced. Both exist
//! because the two run at different moments, and an archive can be edited, truncated or replaced
//! between the two.
//!
//! A dangling reference in an import is not cosmetic. It becomes a message attributed to nobody, an
//! attachment pointing at no bytes, or a conversation in a space that does not exist. Every one of
//! them is caught here, while refusing costs nothing, rather than halfway through a run.
//!
//! Warnings are for what the contract deliberately allows a producer to leave rough, such as a
//! reading position naming a message that did not cross.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::archive::{self, ArchiveError, Index, Member};

/// The seven notices the product knows how to say, each with a sentence in every language. An
/// archive carrying anything else is naming an event we cannot render.
const SYSTEM_EVENTS: &[&str] = &[
    "member_joined",
    "member_left",
    "member_removed",
    "channel_joined",
    "channel_left",
    "channel_removed",
    "channel_created",
];

const KINDS: &[&str] = &["channel", "direct"];
const VISIBILITIES: &[&str] = &["public", "private"];

/// How many kinds of complaint are spelled out before the rest are only counted.
///
/// A hundred distinct problems is already far past the point where anybody reads on, and the number
/// exists so that a thoroughly broken archive produces a page rather than a book.
const FAMILIES_SHOWN: usize = 100;

/// One complaint, and how many times the archive made it.
#[derive(Debug)]
struct Complaint {
    /// The first time it was seen, spelled out with the identifier that carried it.
    example: String,
    times: usize,
}

/// What the checker found.
///
/// Complaints are **grouped by what they say rather than by what they name**. An archive whose
/// every reaction is malformed has one problem seen a hundred and twenty thousand times, not a
/// hundred and twenty thousand problems, and the difference decides whether an administrator reads
/// a sentence or a wall. This is not a display concern: the un-grouped list was megabytes of text
/// travelling to a browser to be shown in a notification, and nobody learned anything from it.
#[derive(Debug, Default)]
pub struct Report {
    errors: Complaints,
    warnings: Complaints,
}

/// What a complaint is about, which is the part that does not change from one occurrence to the
/// next: these messages read "<thing> <identifier>: <what is wrong>", so what is wrong is the tail.
///
/// Two different problems collapse only if they say exactly the same thing, in which case they are
/// the same problem.
/// `tada`, where an emoji belongs. Refused.
fn is_bare_name(emoji: &str) -> bool {
    // `+1` and `-1` are names too, and among the most common of them.
    let mut chars = emoji.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-'))
        && emoji.len() > 1
        && emoji
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-'))
}

/// `:tada:`, a producer saying plainly that it met a name it could not translate. Allowed, because
/// a reaction shown as `:tada:` can still be recognised and put right later, and dropping it
/// entirely would be worse.
fn is_shortcode(emoji: &str) -> bool {
    emoji.len() > 2
        && emoji.starts_with(':')
        && emoji.ends_with(':')
        && is_bare_name(&emoji[1..emoji.len() - 1])
}

fn family(message: &str) -> &str {
    message.split_once(": ").map_or(message, |(_, rest)| rest)
}

/// How many kinds are tracked at all. Past this, occurrences are counted without being told apart:
/// some complaints name a second identifier in their tail and so are their own family, and an
/// archive with a million of those must not turn the checker into a memory problem of its own.
const FAMILIES_TRACKED: usize = 500;

#[derive(Debug, Default)]
struct Complaints {
    /// In the order first seen, because the first thing that went wrong is usually the cause of
    /// everything after it.
    kinds: Vec<Complaint>,
    index: HashMap<String, usize>,
    /// Occurrences past `FAMILIES_TRACKED` kinds, counted rather than kept.
    untracked: usize,
}

impl Complaints {
    fn add(&mut self, message: String) {
        if let Some(at) = self.index.get(family(&message)) {
            self.kinds[*at].times += 1;
            return;
        }
        if self.kinds.len() >= FAMILIES_TRACKED {
            self.untracked += 1;
            return;
        }
        self.index
            .insert(family(&message).to_owned(), self.kinds.len());
        self.kinds.push(Complaint {
            example: message,
            times: 1,
        });
    }

    fn is_empty(&self) -> bool {
        self.kinds.is_empty()
    }

    /// How many times something went wrong, rather than how many ways.
    fn total(&self) -> usize {
        self.kinds.iter().map(|c| c.times).sum::<usize>() + self.untracked
    }
}

/// Renders complaints as lines a person reads, most of them once.
fn lines(complaints: &Complaints) -> Vec<String> {
    let mut out: Vec<String> = complaints
        .kinds
        .iter()
        .take(FAMILIES_SHOWN)
        .map(|c| match c.times {
            1 => c.example.clone(),
            n => format!("{} (and {} more like it)", c.example, n - 1),
        })
        .collect();
    let hidden = complaints.kinds.len().saturating_sub(FAMILIES_SHOWN);
    if hidden > 0 {
        out.push(format!("and {hidden} other kinds of problem, not listed"));
    }
    if complaints.untracked > 0 {
        out.push(format!(
            "and {} further problems, too varied to tell apart",
            complaints.untracked
        ));
    }
    out
}

impl Report {
    fn error(&mut self, message: String) {
        self.errors.add(message);
    }

    fn warn(&mut self, message: String) {
        self.warnings.add(message);
    }

    /// Every kind of error, one line each, with a count when it happened more than once.
    pub fn errors(&self) -> Vec<String> {
        lines(&self.errors)
    }

    /// Every kind of warning, the same way.
    pub fn warnings(&self) -> Vec<String> {
        lines(&self.warnings)
    }

    pub fn is_sound(&self) -> bool {
        self.errors.is_empty()
    }

    /// How many times the archive broke the contract, counting repeats.
    pub fn error_count(&self) -> usize {
        self.errors.total()
    }
}

/// Reads the archive twice: once for the index, once to stream the messages past the checks.
pub fn check(path: &Path, passphrase: Option<&str>) -> Result<(Index, Report), ArchiveError> {
    let index = archive::index(path, passphrase)?;
    let mut report = Report::default();

    let spaces: HashSet<&str> = index.spaces.iter().map(|s| s.id.as_str()).collect();
    let users: HashSet<&str> = index.users.iter().map(|u| u.id.as_str()).collect();
    let files: HashSet<&str> = index.files.iter().map(|f| f.id.as_str()).collect();
    let channels: HashMap<&str, &archive::ChannelRecord> =
        index.channels.iter().map(|c| (c.id.as_str(), c)).collect();

    if index.spaces.is_empty() {
        report.error("the archive names no space: every conversation has to live in one".into());
    }
    if index.spaces.len() != spaces.len() {
        report.error("two spaces share an identifier".into());
    }
    if index.users.len() != users.len() {
        report.error("two accounts share an identifier".into());
    }
    if index.channels.len() != channels.len() {
        report.error("two conversations share an identifier".into());
    }

    check_manifest(&index, &mut report);
    check_spaces(&index, &mut report);
    check_channels(&index, &spaces, &users, &mut report);
    check_files(&index, &mut report);

    // The messages are streamed rather than collected: there can be millions, and the checks that
    // need to look at every one of them still only need one at a time.
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut roots: HashMap<String, String> = HashMap::new();
    archive::walk(path, passphrase, |member| {
        if let Member::Message(message) = member {
            check_message(&message, &channels, &users, &files, &mut report);
            if !seen_ids.insert(message.id.clone()) {
                report.error(format!(
                    "message {}: two messages share an identifier",
                    message.id
                ));
            }
            if message.thread_root.is_none() {
                roots.insert(message.id.clone(), message.channel.clone());
            }
        }
        Ok(())
    })?;

    // Thread roots are resolved in a second sweep: a reply can appear before its root in the file,
    // and refusing that would make the check depend on the producer's ordering.
    archive::walk(path, passphrase, |member| {
        if let Member::Message(message) = member {
            if let Some(root) = &message.thread_root {
                match roots.get(root) {
                    None if seen_ids.contains(root) => report.error(format!(
                        "message {}: its thread root is itself a reply, which our threads do not have",
                        message.id
                    )),
                    None => report.error(format!(
                        "message {}: thread root {root} is not a message in this archive",
                        message.id
                    )),
                    Some(channel) if channel != &message.channel => report.error(format!(
                        "message {}: its thread root is in another conversation",
                        message.id
                    )),
                    Some(_) => {}
                }
            }
        }
        Ok(())
    })?;

    check_member_state(&index, &seen_ids, &mut report);
    Ok((index, report))
}

/// The manifest describes the archive; this is where that description is held to account.
fn check_manifest(index: &Index, report: &mut Report) {
    let Some(manifest) = &index.manifest else {
        return;
    };

    for (name, declared) in &manifest.checksums {
        match index.digests.get(name) {
            None => report.error(format!(
                "the manifest checksums {name}, which is not in the archive"
            )),
            Some(actual) if actual != declared => report.error(format!(
                "{name} does not match its declared checksum: the archive was altered or truncated"
            )),
            Some(_) => {}
        }
    }

    let actual: [(&str, usize); 5] = [
        ("spaces", index.spaces.len()),
        ("users", index.users.len()),
        ("channels", index.channels.len()),
        ("messages", index.message_count),
        ("files", index.files.len()),
    ];
    for (name, count) in actual {
        if let Some(declared) = manifest.counts.get(name) {
            if *declared != count as i64 {
                report.error(format!(
                    "the manifest counts {declared} {name}, the archive holds {count}"
                ));
            }
        }
    }

    if manifest.limits.is_empty() {
        // Every real source leaves something behind. A producer claiming otherwise has not looked.
        report
            .warn("this archive declares no limits at all, which no real source justifies".into());
    }
    if manifest.created_at.is_empty() {
        report.warn("this archive does not say when it was made".into());
    }
}

fn check_spaces(index: &Index, report: &mut Report) {
    for space in &index.spaces {
        if space.name.trim().is_empty() {
            report.error(format!("space {}: no name", space.id));
        }
        if !VISIBILITIES.contains(&space.visibility.as_str()) {
            report.error(format!(
                "space {}: visibility {:?} is not one we have",
                space.id, space.visibility
            ));
        }
    }
}

fn check_channels(
    index: &Index,
    spaces: &HashSet<&str>,
    users: &HashSet<&str>,
    report: &mut Report,
) {
    for channel in &index.channels {
        if !spaces.contains(channel.space.as_str()) {
            report.error(format!(
                "conversation {}: space {:?} is not in this archive",
                channel.id, channel.space
            ));
        }
        if !KINDS.contains(&channel.kind.as_str()) {
            report.error(format!(
                "conversation {}: kind {:?} is not one we have",
                channel.id, channel.kind
            ));
        }
        if !VISIBILITIES.contains(&channel.visibility.as_str()) {
            report.error(format!(
                "conversation {}: visibility {:?} is not one we have",
                channel.id, channel.visibility
            ));
        }
        let unique: HashSet<&str> = channel.members.iter().map(String::as_str).collect();
        if unique.len() != channel.members.len() {
            report.error(format!(
                "conversation {}: the same person is listed twice",
                channel.id
            ));
        }
        for member in &channel.members {
            if !users.contains(member.as_str()) {
                report.error(format!(
                    "conversation {}: member {member:?} is not an account in this archive",
                    channel.id
                ));
            }
        }
        if channel.kind == "direct" && channel.members.len() < 2 {
            report.error(format!(
                "conversation {}: a direct conversation needs at least two people",
                channel.id
            ));
        }
    }
}

fn check_files(index: &Index, report: &mut Report) {
    let users: HashSet<&str> = index.users.iter().map(|u| u.id.as_str()).collect();
    let mut referenced: HashSet<String> = HashSet::new();
    for file in &index.files {
        if file.name.trim().is_empty() {
            report.error(format!(
                "file {}: no name, so nothing could be created",
                file.id
            ));
        }
        if !file.content_type.contains('/') {
            report.error(format!(
                "file {}: {:?} is not a media type, and the file would arrive unopenable",
                file.id, file.content_type
            ));
        }
        if file.path.contains("..") {
            // A path climbing out of the archive is either a broken producer or an attempt to
            // write outside the space. Neither gets to run.
            report.error(format!(
                "file {}: its path climbs out of the archive",
                file.id
            ));
        }
        if let Some(who) = &file.uploaded_by {
            if !users.contains(who.as_str()) && !is_absent_author(who) {
                report.error(format!(
                    "file {}: sent by {who:?}, who is not an account in this archive",
                    file.id
                ));
            }
        }
        if let Some(at) = &file.uploaded_at {
            if !is_instant(at) {
                report.error(format!("file {}: {at:?} is not an instant", file.id));
            }
        }
        let Some(digest) = file.hash.strip_prefix("sha256:") else {
            report.error(format!(
                "file {}: hash {:?} is not sha256:<digest>",
                file.id, file.hash
            ));
            continue;
        };
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
            report.error(format!(
                "file {}: hash {:?} is not a digest",
                file.id, file.hash
            ));
            continue;
        }
        referenced.insert(digest.to_string());
        if !index.blobs.contains(digest) {
            report.error(format!(
                "file {}: its bytes are not in the archive",
                file.id
            ));
        }
    }
    for digest in &index.corrupt_blobs {
        report.error(format!(
            "the bytes filed under {digest} do not hash to it: this archive is damaged"
        ));
    }
    for blob in &index.blobs {
        if !referenced.contains(blob) {
            // At best wasted space; at worst a document that should not have travelled.
            report.error(format!(
                "the archive carries a file nothing points at ({blob})"
            ));
        }
    }
}

fn check_message(
    message: &archive::MessageRecord,
    channels: &HashMap<&str, &archive::ChannelRecord>,
    users: &HashSet<&str>,
    files: &HashSet<&str>,
    report: &mut Report,
) {
    if !is_instant(&message.sent_at) {
        report.error(format!(
            "message {}: {:?} is not an instant like 2026-09-13T11:40:00Z",
            message.id, message.sent_at
        ));
    }
    if let Some(edited) = &message.edited_at {
        if !is_instant(edited) {
            report.error(format!(
                "message {}: {edited:?} is not an instant",
                message.id
            ));
        }
    }
    if message.pinned && message.system_event.is_some() {
        report.error(format!("message {}: a notice cannot be pinned", message.id));
    }

    if !channels.contains_key(message.channel.as_str()) {
        report.error(format!(
            "message {}: conversation {:?} is not in this archive",
            message.id, message.channel
        ));
    }

    match (&message.author, &message.system_event) {
        (None, None) => report.error(format!(
            "message {}: an ordinary message needs an author",
            message.id
        )),
        (Some(author), _) if !users.contains(author.as_str()) && !is_absent_author(author) => {
            report.error(format!(
                "message {}: author {author:?} is neither an account nor marked absent",
                message.id
            ));
        }
        _ => {}
    }

    if let Some(event) = &message.system_event {
        if !SYSTEM_EVENTS.contains(&event.as_str()) {
            report.error(format!(
                "message {}: {event:?} is not a notice we can say",
                message.id
            ));
        }
        if !message.body.is_empty() {
            report.error(format!(
                "message {}: a notice carries an event, never a sentence",
                message.id
            ));
        }
    }

    for reaction in &message.reactions {
        if reaction.emoji.trim().is_empty() {
            report.error(format!("message {}: a reaction with no emoji", message.id));
        }
        if reaction.by.is_empty() {
            report.error(format!(
                "message {}: a {:?} reaction by nobody",
                message.id, reaction.emoji
            ));
        }
        // The product stores the character. A bare name arrives as that word sitting under the
        // message, where a face should be, and nothing afterwards says it was ever meant to be one.
        if is_bare_name(&reaction.emoji) {
            report.error(format!(
                "message {}: reaction {:?} is a name, not an emoji",
                message.id, reaction.emoji
            ));
        } else if is_shortcode(&reaction.emoji) {
            report.warn(format!(
                "message {}: reaction {:?} could not be translated by its producer and will be \
                 shown as text",
                message.id, reaction.emoji
            ));
        }
        for who in &reaction.by {
            if !users.contains(who.as_str()) && !is_absent_author(who) {
                report.error(format!(
                    "message {}: reacted to by {who:?}, who is not an account",
                    message.id
                ));
            }
        }
    }
    for who in &message.saved_by {
        if !users.contains(who.as_str()) {
            report.error(format!(
                "message {}: saved by {who:?}, who is not an account",
                message.id
            ));
        }
    }
    for reference in &message.files {
        if !files.contains(reference.as_str()) {
            report.error(format!(
                "message {}: attachment {reference:?} is not in this archive",
                message.id
            ));
        }
    }
}

fn check_member_state(index: &Index, messages: &HashSet<String>, report: &mut Report) {
    for channel in &index.channels {
        let members: HashSet<&str> = channel.members.iter().map(String::as_str).collect();
        let mut seen: HashSet<&str> = HashSet::new();
        for entry in &channel.member_state {
            if !seen.insert(entry.user.as_str()) {
                report.error(format!(
                    "conversation {}: two entries for {:?} in what its members kept",
                    channel.id, entry.user
                ));
            }
            if !members.contains(entry.user.as_str()) {
                report.error(format!(
                    "conversation {}: {:?} kept something here and is not a member. \
                     The producer disagrees with itself about who is in this conversation.",
                    channel.id, entry.user
                ));
            }
            if let Some(read) = &entry.read_message {
                if !messages.contains(read) {
                    // Allowed: the run moves it back to the nearest message it holds.
                    report.warn(format!(
                        "conversation {}: {:?} had read up to a message that is not in this archive",
                        channel.id, entry.user
                    ));
                }
            }
        }
    }
}

/// The archive spells every instant the same way, and only that way: parsing it later would fail
/// somewhere far from here, on a row already half written.
fn is_instant(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'Z'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7 | 10 | 13 | 16 | 19) || b.is_ascii_digit())
}

/// A guest, a bot, someone the producer could not resolve: spelled `<kind>:<id>` so the run knows
/// to attribute the message to a marked absent author rather than dropping it.
fn is_absent_author(author: &str) -> bool {
    author
        .split_once(':')
        .is_some_and(|(kind, rest)| !kind.is_empty() && !rest.is_empty())
}

#[cfg(test)]
mod report_tests {
    use super::*;

    /// The failure that prompted all of this: an archive whose every reaction was malformed
    /// produced one error per reaction, and the whole list travelled to a browser to be shown in a
    /// notification. A hundred and twenty thousand lines say nothing that one line and a count do
    /// not.
    #[test]
    fn the_same_complaint_about_many_things_is_one_line_and_a_count() {
        let mut report = Report::default();
        for n in 0..120_000 {
            report.error(format!("message m{n:06}: a reaction by nobody"));
        }
        let lines = report.errors();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("message m000000: a reaction by nobody"));
        assert!(lines[0].contains("119999 more like it"), "{}", lines[0]);
    }

    #[test]
    fn a_complaint_seen_once_is_spelled_out_with_nothing_added() {
        let mut report = Report::default();
        report.error("space s1: no name".into());
        assert_eq!(report.errors(), vec!["space s1: no name".to_owned()]);
    }

    #[test]
    fn different_complaints_stay_apart() {
        let mut report = Report::default();
        report.error("space s1: no name".into());
        report.error("message m1: a notice cannot be pinned".into());
        report.error("space s2: no name".into());
        let lines = report.errors();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("1 more like it"));
        assert!(lines[1].contains("a notice cannot be pinned"));
    }

    #[test]
    fn the_first_thing_that_went_wrong_is_listed_first() {
        // Usually the cause of everything after it, so order is kept rather than sorted by count.
        let mut report = Report::default();
        report.error("message m1: a notice cannot be pinned".into());
        for n in 0..50 {
            report.error(format!("space s{n}: no name"));
        }
        assert!(report.errors()[0].contains("a notice cannot be pinned"));
    }

    #[test]
    fn a_complaint_with_no_colon_is_its_own_family() {
        let mut report = Report::default();
        report.error("the archive names no space".into());
        report.error("two spaces share an identifier".into());
        assert_eq!(report.errors().len(), 2);
    }

    /// Some complaints name a second identifier in their tail and so are each their own kind. That
    /// must not turn a broken archive into a memory problem of its own.
    #[test]
    fn endlessly_varied_complaints_are_counted_rather_than_kept() {
        let mut report = Report::default();
        for n in 0..50_000 {
            report.error(format!("message m{n}: its thread root r{n} is elsewhere"));
        }
        // A hundred spelled out, then the kinds that were tracked but not shown, then everything
        // past the point where telling them apart stopped being worth the memory.
        let lines = report.errors();
        assert_eq!(lines.len(), FAMILIES_SHOWN + 2);
        assert!(lines[FAMILIES_SHOWN].contains("400 other kinds"), "{lines:?}");
        assert!(
            lines.last().unwrap().contains("too varied to tell apart"),
            "{:?}",
            lines.last()
        );
        assert_eq!(report.error_count(), 50_000);
    }

    #[test]
    fn past_a_hundred_kinds_the_rest_are_summarised() {
        let mut report = Report::default();
        for n in 0..150 {
            report.error(format!("message m{n}: problem number {n}"));
        }
        let lines = report.errors();
        assert_eq!(lines.len(), FAMILIES_SHOWN + 1);
        assert!(lines.last().unwrap().contains("50 other kinds"), "{lines:?}");
    }

    #[test]
    fn counting_is_of_occurrences_not_of_kinds() {
        let mut report = Report::default();
        for n in 0..1_000 {
            report.error(format!("message m{n}: a reaction by nobody"));
        }
        assert_eq!(report.errors().len(), 1);
        assert_eq!(report.error_count(), 1_000);
    }

    #[test]
    fn warnings_are_grouped_the_same_way_and_do_not_make_an_archive_unsound() {
        let mut report = Report::default();
        for n in 0..10 {
            report.warn(format!("channel c{n}: an entry that says nothing"));
        }
        assert_eq!(report.warnings().len(), 1);
        assert!(report.is_sound());
        assert_eq!(report.error_count(), 0);
    }
}

#[cfg(test)]
mod emoji_tests {
    use super::{is_bare_name, is_shortcode};

    #[test]
    fn a_character_is_neither_a_name_nor_a_shortcode() {
        for emoji in ["🎉", "👍", "❤️", "🇫🇷"] {
            assert!(!is_bare_name(emoji), "{emoji}");
            assert!(!is_shortcode(emoji), "{emoji}");
        }
    }

    #[test]
    fn a_bare_name_is_caught() {
        for name in ["tada", "thumbsup", "+1", "white_check_mark", "100"] {
            assert!(is_bare_name(name), "{name}");
        }
    }

    #[test]
    fn a_shortcode_is_told_apart_from_a_bare_name() {
        assert!(is_shortcode(":shipit:"));
        assert!(!is_bare_name(":shipit:"));
    }

    #[test]
    fn a_lone_letter_or_colon_is_not_mistaken_for_either() {
        // A single character can be an emoji nobody expected; being over-eager here would refuse
        // an archive over something that is not wrong.
        assert!(!is_bare_name("a"));
        assert!(!is_shortcode("::"));
        assert!(!is_shortcode(":"));
        assert!(!is_shortcode(""));
    }
}
