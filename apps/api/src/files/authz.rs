//! File authorization: the membership choke point for the files surface.
//!
//! Read access to a file follows space membership: the Files screen is space-wide by design (like
//! public-channel history being open to space members), so any member of a file's space may list,
//! preview and download its files. Mutations (upload a new version, rename, move, delete, share)
//! require the file's owner or a space owner/admin.
//!
//! **A file carrying a `conversation_id` is the exception**: it was attached to a message in a
//! private channel or a direct message, and its audience is that conversation's, not the space's.
//! Without this, sending a document in a direct message would publish it to everyone in the space.
//! Such a file is also kept out of the space tree, so the two rules never disagree about who can see
//! what.
//!
//! **A guest has no space-wide read.** The Files screen is the space's, and a guest is not in the
//! space that way: they reach a file only where it hangs off a message in a conversation they may
//! read. That second path matters, because an attachment posted in a *public* channel carries no
//! `conversation_id` (it joins the space tree), so without it a guest could see a message and not
//! the document it is about.

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

use super::error::FileError;
use crate::entities::{files, message_attachments, messages, space_members};

/// A resolved, authorized handle to a file the caller may access.
pub struct FileAccess {
    /// The file row (guaranteed to be in a space the caller belongs to, and not soft-deleted).
    pub file: files::Model,
    /// Whether the caller may mutate the file (owner, or a space owner/admin).
    pub can_edit: bool,
}

/// Ensure the caller belongs to a space, or fail with `403`.
pub async fn ensure_space_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), FileError> {
    space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|_| ())
        .ok_or(FileError::Forbidden)
}

/// Ensure the caller may address the space's own files: its tree, its folders, its uploads.
///
/// Membership, and not the guest kind of it. The Files screen holds everything the organisation has
/// put in the space, which is precisely what an external guest is not being given.
pub async fn ensure_space_files_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), FileError> {
    ensure_space_member(db, space_id, user_id).await?;
    match crate::messaging::authz::is_guest(db, space_id, user_id).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(FileError::Forbidden),
        Err(_) => Err(FileError::Internal),
    }
}

/// Whether a file hangs off a message in a conversation the caller may read.
///
/// The narrow door left open to a guest: they see the message, so they get the document attached to
/// it. Checked message by message, because one file can be attached in several places and only one
/// of them needs to be readable.
async fn reaches_through_a_message(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<bool, FileError> {
    let message_ids: Vec<Uuid> = message_attachments::Entity::find()
        .filter(message_attachments::Column::FileId.eq(file_id))
        .all(db)
        .await?
        .into_iter()
        .map(|attachment| attachment.message_id)
        .collect();
    if message_ids.is_empty() {
        return Ok(false);
    }
    let conversations: std::collections::BTreeSet<Uuid> = messages::Entity::find()
        .filter(messages::Column::Id.is_in(message_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|message| message.conversation_id)
        .collect();
    for conversation_id in conversations {
        if conversation_access(db, conversation_id, user_id)
            .await
            .is_ok()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the caller is an `owner`/`admin` of a space.
pub async fn is_space_admin(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, FileError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|m| m.role == "owner" || m.role == "admin")
        .unwrap_or(false))
}

/// Resolve a conversation for the files surface, translating the messaging error into a file one.
///
/// The two surfaces have their own error types on purpose (each maps to its own HTTP shape), so the
/// crossing happens here, once, rather than at every call site. An internal failure stays internal;
/// everything else collapses into the same flat `403` the messaging side would have returned.
pub async fn conversation_access(
    db: &DatabaseConnection,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<crate::messaging::authz::ConversationAccess, FileError> {
    crate::messaging::authz::ensure_conversation_access(db, conversation_id, user_id)
        .await
        .map_err(|error| match error {
            crate::messaging::error::ApiError::Internal => FileError::Internal,
            _ => FileError::Forbidden,
        })
}

/// Resolve and authorize a file for reading, or fail with `403` (never revealing whether the file
/// exists to a non-member). A soft-deleted file is a `404` for a member who addresses it by id.
pub async fn ensure_readable(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<FileAccess, FileError> {
    let file = files::Entity::find_by_id(file_id)
        .one(db)
        .await?
        .ok_or(FileError::Forbidden)?;
    match file.conversation_id {
        // Attached to a private conversation: its participants are the audience, and nobody else.
        Some(conversation_id) => {
            conversation_access(db, conversation_id, user_id).await?;
        }
        None => {
            ensure_space_member(db, file.space_id, user_id).await?;
            // A space-tree file: open to the space, except to a guest, who only reaches it through
            // a message they can read.
            let guest = crate::messaging::authz::is_guest(db, file.space_id, user_id)
                .await
                .map_err(|_| FileError::Internal)?;
            if guest && !reaches_through_a_message(db, file.id, user_id).await? {
                return Err(FileError::Forbidden);
            }
        }
    }
    if file.deleted_at.is_some() {
        return Err(FileError::NotFound);
    }
    let can_edit =
        file.owner_id == Some(user_id) || is_space_admin(db, file.space_id, user_id).await?;
    Ok(FileAccess { file, can_edit })
}

/// Resolve and authorize a file for mutation (owner or space owner/admin), or fail with `403`.
pub async fn ensure_editable(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<FileAccess, FileError> {
    let access = ensure_readable(db, file_id, user_id).await?;
    if !access.can_edit {
        return Err(FileError::Forbidden);
    }
    Ok(access)
}
