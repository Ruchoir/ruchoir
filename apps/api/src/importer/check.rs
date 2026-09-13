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

#[derive(Debug, Default)]
pub struct Report {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl Report {
    fn error(&mut self, message: String) {
        self.errors.push(message);
    }

    fn warn(&mut self, message: String) {
        self.warnings.push(message);
    }

    pub fn is_sound(&self) -> bool {
        self.errors.is_empty()
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
