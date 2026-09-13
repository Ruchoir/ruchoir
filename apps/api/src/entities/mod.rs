//! SeaORM entity models, mapping the database schema created by the migrations.

// Auth core.
pub mod recovery_codes;
pub mod totp_secrets;
pub mod users;
pub mod webauthn_credentials;

// Spaces, membership and channels.
pub mod channel_members;
pub mod channels;
pub mod conversations;
pub mod dm_conversations;
pub mod dm_participants;
pub mod space_invitations;
pub mod space_members;
pub mod space_slugs;
pub mod spaces;

// Files.
pub mod file_shares;
pub mod file_versions;
pub mod files;

// Messaging.
pub mod channel_pins;
pub mod channel_role_access;
pub mod message_attachments;
pub mod message_link_previews;
pub mod message_mentions;
pub mod message_reactions;
pub mod messages;
pub mod notifications;
pub mod read_cursors;
pub mod user_saved_messages;

// Bringing a workspace over from another product. Driven by the import tests against a real
// database, and not yet by the binary: the caller is the background task that runs a job, which is
// the next slice. The allowance is narrow and temporary, and goes away with that task.
#[cfg_attr(not(test), allow(dead_code))]
pub mod import_jobs;
#[cfg_attr(not(test), allow(dead_code))]
pub mod import_mappings;

// Per-user client preferences.
pub mod user_preferences;

// Server-wide settings, one row.
pub mod instance_settings;
