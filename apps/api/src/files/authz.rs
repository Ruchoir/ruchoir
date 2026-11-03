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
//!
//! **Every rule above is decided by the permission engine** (`crate::permissions`): reading is
//! `files.view` (a conversation's file mapped onto reading that conversation, a guest's path
//! through a message and a calendar event's read-only path included), renaming, moving, deleting
//! and sharing `files.manage` (the author, or whoever administers the space), editing the content
//! `files.edit`, publishing a link `files.public_link`. This module keeps the file-shaped answers
//! and their flat `403`.

use sea_orm::{DatabaseConnection, EntityTrait};
use uuid::Uuid;

use super::error::FileError;
use crate::entities::{files, space_members};
use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Resource};

/// A resolved, authorized handle to a file the caller may access.
pub struct FileAccess {
    /// The file row (in a space the caller belongs to, or carried by an event they see; not
    /// soft-deleted).
    pub file: files::Model,
    /// Whether the caller may mutate the file (`files.manage`: its author, or whoever administers
    /// the space).
    pub can_edit: bool,
    /// Whether the caller reads it only because a calendar event they see carries it: read only,
    /// its content included.
    pub through_event: bool,
}

/// Require a permission (`crate::permissions`) on a resource of a space, or fail with `403`.
pub async fn ensure_permission(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
    permission: Permission,
) -> Result<(), FileError> {
    if check::can(db, space_id, user_id, resource, permission).await? {
        Ok(())
    } else {
        Err(FileError::Forbidden)
    }
}

/// Tell each listed entry what the caller may do with it (`my_permissions`), in bulk per space.
pub async fn mark_permissions(
    db: &DatabaseConnection,
    user_id: Uuid,
    entries: &mut [super::dto::FileDto],
) -> Result<(), FileError> {
    let mut by_space: std::collections::HashMap<Uuid, Vec<Uuid>> = Default::default();
    for entry in entries.iter() {
        by_space.entry(entry.space_id).or_default().push(entry.id);
    }
    let mut rights = std::collections::HashMap::new();
    for (space_id, ids) in by_space {
        rights.extend(check::files_effective(db, space_id, user_id, &ids).await?);
    }
    for entry in entries.iter_mut() {
        entry.my_permissions = Some(
            rights
                .get(&entry.id)
                .copied()
                .unwrap_or_default()
                .to_names(),
        );
    }
    Ok(())
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

/// Ensure the caller may address the space's own files: its tree, its folders, its trash
/// (`files.view` on the space).
///
/// Membership, and not the guest kind of it. The Files screen holds everything the organisation has
/// put in the space, which is precisely what an external guest is not being given.
pub async fn ensure_space_files_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), FileError> {
    ensure_permission(
        db,
        space_id,
        user_id,
        Resource::Space,
        Permission::FilesView,
    )
    .await
}

/// Ensure the caller may add to the space's files: upload, create a folder or a blank document
/// (`files.create` on the space).
pub async fn ensure_space_files_creator(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), FileError> {
    ensure_permission(
        db,
        space_id,
        user_id,
        Resource::Space,
        Permission::FilesCreate,
    )
    .await
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

/// Resolve and authorize a file for reading (`files.view`), or fail with `403` (never revealing
/// whether the file exists to a non-member). A soft-deleted file is a `404` for someone who could
/// read it.
///
/// **A calendar event gives access to the files it carries**: whoever sees the event reads them,
/// read only, even from outside the file's audience (see `crate::calendar::attachments`).
pub async fn ensure_readable(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<FileAccess, FileError> {
    let file = files::Entity::find_by_id(file_id)
        .one(db)
        .await?
        .ok_or(FileError::Forbidden)?;
    let rights = check::file_rights(db, file.space_id, user_id, file_id).await?;
    if !rights.granted.contains(Permission::FilesView) {
        return Err(FileError::Forbidden);
    }
    if file.deleted_at.is_some() {
        return Err(FileError::NotFound);
    }
    Ok(FileAccess {
        file,
        can_edit: rights.granted.contains(Permission::FilesManage),
        through_event: rights.through_event,
    })
}

/// Resolve and authorize a file for mutation (`files.manage`), or fail with `403`.
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

/// Resolve and authorize a file for editing its content in the office editor (`files.edit`), or
/// fail with `403`.
///
/// Wider than [`ensure_editable`] on purpose: a document a team works on is edited by the team, not
/// only by whoever uploaded it. Whoever may read the file and is not a guest of its space may edit
/// its content; renaming, moving, deleting and uploading a version by hand stay with
/// [`ensure_editable`].
pub async fn ensure_content_editable(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<FileAccess, FileError> {
    let access = ensure_readable(db, file_id, user_id).await?;
    if access.file.kind == "folder" {
        return Err(FileError::BadRequest("a folder has no content to edit"));
    }
    // Reading a file through a calendar event is reading it, not working on it.
    if access.through_event {
        return Err(FileError::Forbidden);
    }
    ensure_permission(
        db,
        access.file.space_id,
        user_id,
        Resource::File(file_id),
        Permission::FilesEdit,
    )
    .await?;
    Ok(access)
}
