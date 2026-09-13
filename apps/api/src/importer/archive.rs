//! Reading an import archive: opening it, and turning its lines into records.
//!
//! The archive is described in `docs/import-archive.md` and produced by the tooling in
//! `packages/importer`. Everything here is one-way: this module reads, and never writes to the
//! database.
//!
//! **The clear archive never lands on disk.** A sealed archive is decrypted as it is read, and the
//! decrypted bytes go straight into the tar reader, which hands one entry at a time to a visitor.
//! An import of several gigabytes therefore costs one buffer, not one temporary copy of a
//! company's entire history sitting in `/tmp` waiting to be forgotten about.
//!
//! A tar is a stream, so it is read front to back once per pass. Analysis makes one pass over the
//! small tables; the run makes another over the messages. Opening twice is cheaper, and far
//! simpler, than holding the whole thing.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Format versions this build knows how to read. An archive from a newer producer is refused
/// rather than guessed at.
pub const SUPPORTED_FORMAT_VERSIONS: &[u32] = &[1];

/// Everything that can go wrong while reading an archive.
///
/// Hand-written rather than derived: the project has no error-derive dependency, and these
/// messages are read by an administrator, so they are written for them.
#[derive(Debug)]
pub enum ArchiveError {
    /// Kept apart from every other failure on purpose: a wrong passphrase and a corrupt archive
    /// send an administrator down completely different roads, and telling them apart is the
    /// difference between "try again" and "your export is unusable".
    WrongPassphrase,
    PassphraseMissing,
    Unreadable(String),
    MissingMember(&'static str),
    BadRecord {
        file: String,
        line: usize,
        reason: String,
    },
    UnsupportedVersion {
        found: u32,
        supported: Vec<u32>,
    },
    Io(String),
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArchiveError::WrongPassphrase => {
                write!(f, "the passphrase does not open this archive")
            }
            ArchiveError::PassphraseMissing => {
                write!(f, "this archive is sealed and no passphrase was given")
            }
            ArchiveError::Unreadable(reason) => write!(f, "the archive is not readable: {reason}"),
            ArchiveError::MissingMember(name) => write!(f, "{name} is missing from the archive"),
            ArchiveError::BadRecord { file, line, reason } => {
                write!(f, "{file}, line {line}: {reason}")
            }
            ArchiveError::UnsupportedVersion { found, supported } => write!(
                f,
                "this archive says it is format version {found}, and this build reads {supported:?}"
            ),
            ArchiveError::Io(reason) => write!(f, "{reason}"),
        }
    }
}

impl std::error::Error for ArchiveError {}

type Result<T> = std::result::Result<T, ArchiveError>;

// --- what an archive says about itself ------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub format_version: u32,
    pub source: String,
    #[serde(default)]
    pub source_version: String,
    #[serde(default)]
    pub producer: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub counts: BTreeMap<String, i64>,
    #[serde(default)]
    pub checksums: BTreeMap<String, String>,
    /// What the producer could not take, in its own words. Shown to the administrator before the
    /// run, never summarised and never hidden.
    #[serde(default)]
    pub limits: Vec<String>,
}

// --- the records ------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct SpaceRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub visibility: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserRecord {
    pub id: String,
    #[serde(default)]
    pub email: String,
    pub display_name: String,
    #[serde(default = "yes")]
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemberStateRecord {
    pub user: String,
    #[serde(default)]
    pub favorite: bool,
    /// The source named the last message read. Preferred when present: it needs no guessing.
    #[serde(default)]
    pub read_message: Option<String>,
    /// The source only knew a moment. Resolved to the last message sent at or before it.
    #[serde(default)]
    pub read_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelRecord {
    pub id: String,
    pub space: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub visibility: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub member_state: Vec<MemberStateRecord>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReactionRecord {
    pub emoji: String,
    #[serde(default)]
    pub by: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageRecord {
    pub id: String,
    pub channel: String,
    /// `None` on a notice that is about nobody, such as a conversation being created.
    #[serde(default)]
    pub author: Option<String>,
    pub sent_at: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub thread_root: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub edited_at: Option<String>,
    /// An event name, never a sentence: the wording is ours, in the reader's language.
    #[serde(default)]
    pub system_event: Option<String>,
    #[serde(default)]
    pub reactions: Vec<ReactionRecord>,
    #[serde(default)]
    pub saved_by: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub content_type: String,
    pub hash: String,
    #[serde(default)]
    pub uploaded_by: Option<String>,
    #[serde(default)]
    pub uploaded_at: Option<String>,
}

fn yes() -> bool {
    true
}

// --- what one pass hands back -------------------------------------------------------------------

/// Everything except the messages and the bytes: small enough to hold, and enough to build the
/// plan an administrator approves before anything is written.
#[derive(Debug, Default)]
pub struct Index {
    pub manifest: Option<Manifest>,
    pub spaces: Vec<SpaceRecord>,
    pub users: Vec<UserRecord>,
    pub channels: Vec<ChannelRecord>,
    pub files: Vec<FileRecord>,
    pub message_count: usize,
    /// The digest of each JSONL member as it was actually read, so the manifest's claim about
    /// itself can be checked. Small files, so hashing them at analysis costs nothing; the blobs
    /// are verified during the run instead, when their bytes are being read anyway.
    pub digests: BTreeMap<String, String>,
    /// Digests found under `blobs/`, so a file record pointing at nothing is caught before the run
    /// rather than halfway through it.
    pub blobs: std::collections::HashSet<String>,
    /// Blobs whose bytes do not hash to the name they are filed under: the archive is damaged, and
    /// the file would arrive corrupted without anyone noticing.
    pub corrupt_blobs: Vec<String>,
}

/// What the reader hands to its caller, entry by entry.
pub enum Member<'a> {
    Manifest(Manifest),
    Space(SpaceRecord),
    User(UserRecord),
    Channel(ChannelRecord),
    Message(MessageRecord),
    File(FileRecord),
    /// A blob, with a reader positioned on its bytes. The digest is its name in the archive.
    Blob {
        digest: String,
        reader: &'a mut dyn Read,
    },
    /// What a JSONL member hashed to, emitted once the member has been read through.
    Digest {
        name: String,
        digest: String,
    },
}

/// Opens an archive and walks it once, handing each member to `visit`.
///
/// `passphrase` is required for a sealed archive and ignored for a clear one, so a caller does not
/// have to know which it has before opening it.
pub fn walk<F>(path: &Path, passphrase: Option<&str>, mut visit: F) -> Result<()>
where
    F: FnMut(Member<'_>) -> Result<()>,
{
    // An unpacked archive is a directory: that is what a producer writes before sealing, and what
    // a developer has in front of them. Reading both costs one branch and saves everyone the
    // ceremony of taring a directory just to look at it.
    if path.is_dir() {
        return walk_directory(path, &mut visit);
    }

    let file = File::open(path).map_err(|e| ArchiveError::Io(e.to_string()))?;
    let mut head = BufReader::new(file);

    if is_sealed(&mut head)? {
        let passphrase = passphrase.ok_or(ArchiveError::PassphraseMissing)?;
        let message = pgp::composed::Message::from_bytes(head)
            .map_err(|e| ArchiveError::Unreadable(e.to_string()))?;
        let decrypted = message
            .decrypt_with_password(&passphrase.into())
            .map_err(|_| ArchiveError::WrongPassphrase)?;
        // gpg compresses by default; a clear tar simply passes through.
        let decrypted = decrypted
            .decompress()
            .map_err(|e| ArchiveError::Unreadable(e.to_string()))?;
        walk_tar(decrypted, &mut visit)
    } else {
        walk_tar(head, &mut visit)
    }
}

/// Reads everything but the messages, and counts those.
pub fn index(path: &Path, passphrase: Option<&str>) -> Result<Index> {
    let mut index = Index::default();
    walk(path, passphrase, |member| {
        match member {
            Member::Manifest(m) => index.manifest = Some(m),
            Member::Space(s) => index.spaces.push(s),
            Member::User(u) => index.users.push(u),
            Member::Channel(c) => index.channels.push(c),
            Member::File(f) => index.files.push(f),
            Member::Message(_) => index.message_count += 1,
            Member::Blob { digest, reader } => {
                // Hashing costs nothing extra: the bytes have to be read through anyway to reach
                // the next member, and a blob whose content does not match its name is a file
                // that would arrive silently corrupted.
                let mut hasher = Sha256::new();
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let read = reader
                        .read(&mut buffer)
                        .map_err(|e| ArchiveError::Io(e.to_string()))?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                }
                let actual = to_hex(&hasher.finalize());
                if actual != digest {
                    index.corrupt_blobs.push(digest.clone());
                }
                index.blobs.insert(digest);
            }
            Member::Digest { name, digest } => {
                index.digests.insert(name, digest);
            }
        }
        Ok(())
    })?;

    match &index.manifest {
        None => return Err(ArchiveError::MissingMember("manifest.json")),
        Some(manifest) if !SUPPORTED_FORMAT_VERSIONS.contains(&manifest.format_version) => {
            return Err(ArchiveError::UnsupportedVersion {
                found: manifest.format_version,
                supported: SUPPORTED_FORMAT_VERSIONS.to_vec(),
            })
        }
        Some(_) => {}
    }
    Ok(index)
}

/// Walks an unpacked archive, in the order a tar would hand it over.
fn walk_directory<F>(root: &Path, visit: &mut F) -> Result<()>
where
    F: FnMut(Member<'_>) -> Result<()>,
{
    let manifest_path = root.join("manifest.json");
    if manifest_path.is_file() {
        let text =
            std::fs::read_to_string(&manifest_path).map_err(|e| ArchiveError::Io(e.to_string()))?;
        let manifest: Manifest =
            serde_json::from_str(&text).map_err(|e| ArchiveError::BadRecord {
                file: "manifest.json".into(),
                line: 0,
                reason: e.to_string(),
            })?;
        visit(Member::Manifest(manifest))?;
    }

    for name in [
        "spaces.jsonl",
        "users.jsonl",
        "channels.jsonl",
        "messages.jsonl",
        "files.jsonl",
    ] {
        let path = root.join(name);
        if !path.is_file() {
            continue;
        }
        let file = File::open(&path).map_err(|e| ArchiveError::Io(e.to_string()))?;
        match name {
            "spaces.jsonl" => hashed(file, name, visit, Member::Space)?,
            "users.jsonl" => hashed(file, name, visit, Member::User)?,
            "channels.jsonl" => hashed(file, name, visit, Member::Channel)?,
            "messages.jsonl" => hashed(file, name, visit, Member::Message)?,
            _ => hashed(file, name, visit, Member::File)?,
        }
    }

    let blobs = root.join("blobs");
    if blobs.is_dir() {
        walk_blobs(&blobs, visit)?;
    }
    Ok(())
}

fn walk_blobs<F>(directory: &Path, visit: &mut F) -> Result<()>
where
    F: FnMut(Member<'_>) -> Result<()>,
{
    let entries = std::fs::read_dir(directory).map_err(|e| ArchiveError::Io(e.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|e| ArchiveError::Io(e.to_string()))?;
        let path = entry.path();
        if path.is_dir() {
            walk_blobs(&path, visit)?;
            continue;
        }
        let digest = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut file = File::open(&path).map_err(|e| ArchiveError::Io(e.to_string()))?;
        visit(Member::Blob {
            digest,
            reader: &mut file,
        })?;
    }
    Ok(())
}

/// An OpenPGP message starts with a packet tag: bit 7 set. A tar starts with a file name, so its
/// first byte is printable. That is enough to tell a sealed archive from a clear one without
/// asking the caller to know.
fn is_sealed(reader: &mut BufReader<File>) -> Result<bool> {
    let head = reader
        .fill_buf()
        .map_err(|e| ArchiveError::Io(e.to_string()))?;
    Ok(head.first().is_some_and(|byte| byte & 0x80 != 0))
}

fn walk_tar<R, F>(reader: R, visit: &mut F) -> Result<()>
where
    R: Read,
    F: FnMut(Member<'_>) -> Result<()>,
{
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| ArchiveError::Unreadable(e.to_string()))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| ArchiveError::Unreadable(e.to_string()))?;
        let path = entry
            .path()
            .map_err(|e| ArchiveError::Unreadable(e.to_string()))?
            .to_path_buf();

        // A producer may or may not wrap the archive in a directory; either is fine, and only the
        // trailing name matters.
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let in_blobs = path.components().any(|c| c.as_os_str() == "blobs");

        if in_blobs {
            if entry.header().entry_type().is_file() {
                visit(Member::Blob {
                    digest: name,
                    reader: &mut entry,
                })?;
            }
            continue;
        }

        match name.as_str() {
            "manifest.json" => {
                let mut text = String::new();
                entry
                    .read_to_string(&mut text)
                    .map_err(|e| ArchiveError::Io(e.to_string()))?;
                let manifest: Manifest =
                    serde_json::from_str(&text).map_err(|e| ArchiveError::BadRecord {
                        file: "manifest.json".into(),
                        line: 0,
                        reason: e.to_string(),
                    })?;
                visit(Member::Manifest(manifest))?;
            }
            "spaces.jsonl" => hashed(&mut entry, &name, visit, Member::Space)?,
            "users.jsonl" => hashed(&mut entry, &name, visit, Member::User)?,
            "channels.jsonl" => hashed(&mut entry, &name, visit, Member::Channel)?,
            "messages.jsonl" => hashed(&mut entry, &name, visit, Member::Message)?,
            "files.jsonl" => hashed(&mut entry, &name, visit, Member::File)?,
            // Anything else is not ours to interpret. Ignored rather than refused: a producer may
            // add a member a later format version reads, and refusing would break a valid archive.
            _ => {}
        }
    }
    Ok(())
}

/// Reads a JSONL member while hashing the bytes that go past, and emits the digest afterwards.
/// The hash costs one pass we were making anyway, so checking the manifest's claim is free.
fn hashed<T, R, F, M>(entry: R, name: &str, visit: &mut F, wrap: M) -> Result<()>
where
    T: for<'de> Deserialize<'de>,
    R: Read,
    F: FnMut(Member<'_>) -> Result<()>,
    M: Fn(T) -> Member<'static>,
{
    let mut tee = Tee {
        inner: entry,
        hasher: Sha256::new(),
    };
    read_lines(&mut tee, name, |record| visit(wrap(record)))?;
    let digest = format!("sha256:{}", to_hex(&tee.hasher.finalize()));
    visit(Member::Digest {
        name: name.to_string(),
        digest,
    })
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// A reader that hashes what it hands on.
struct Tee<R> {
    inner: R,
    hasher: Sha256,
}

impl<R: Read> Read for Tee<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.hasher.update(&buf[..read]);
        Ok(read)
    }
}

/// JSON Lines, read one line at a time: a messages file can hold millions and is never collected.
fn read_lines<T, R, F>(entry: R, file: &str, mut emit: F) -> Result<()>
where
    T: for<'de> Deserialize<'de>,
    R: Read,
    F: FnMut(T) -> Result<()>,
{
    let reader = BufReader::new(entry);
    for (number, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| ArchiveError::Io(e.to_string()))?;
        if line.trim().is_empty() {
            continue;
        }
        let record: T = serde_json::from_str(&line).map_err(|e| ArchiveError::BadRecord {
            file: file.to_string(),
            line: number + 1,
            reason: e.to_string(),
        })?;
        emit(record)?;
    }
    Ok(())
}
