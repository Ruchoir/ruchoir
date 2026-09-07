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
pub mod message_attachments;
pub mod message_link_previews;
pub mod message_mentions;
pub mod message_reactions;
pub mod messages;
pub mod notifications;
pub mod read_cursors;
pub mod user_saved_messages;

// Per-user client preferences.
pub mod user_preferences;
