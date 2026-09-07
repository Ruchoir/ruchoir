//! Uploads a user triggers outside the Files screen: message attachments, avatars and space icons.
//!
//! Two unrelated shapes, for one reason each.
//!
//! **`files.conversation_id`** gives a file an audience. Reading a file has so far followed space
//! membership, which is right for the Files screen but would mean a document sent in a direct
//! message or a private channel became readable by the whole space. Set, this column says the file
//! belongs to that conversation: it stays out of the space tree and its read access resolves through
//! conversation membership instead. Null keeps the existing behaviour exactly, so every file created
//! before this migration is unaffected.
//!
//! **`files.system_key`** marks a folder the product creates rather than a person: the one public
//! attachments land in. Looking it up by name would break the moment someone renamed it, which they
//! may, because it is an ordinary folder in their tree.
//!
//! **`users.avatar_key` and `spaces.icon_key`** replace `avatar_file_id` and `icon_file_id`, which
//! were added early and never written. An avatar is not a document: one per account, replaced rather
//! than versioned, visible to anyone sharing a space, and belonging in nobody's file tree. It cannot
//! be a `files` row at all without making `space_id` nullable, and that column is in every file
//! authorization query. These hold an object-store key instead, carrying a fresh id on each upload so
//! the URL changes with the image and nothing has to invalidate a cache.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Files::Table)
                    .add_column(ColumnDef::new(Files::ConversationId).uuid().null())
                    .add_column(ColumnDef::new(Files::SystemKey).text().null())
                    .add_foreign_key(
                        TableForeignKey::new()
                            .name("fk_files_conversation")
                            .from_tbl(Files::Table)
                            .from_col(Files::ConversationId)
                            .to_tbl(Conversations::Table)
                            .to_col(Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // Conversation-private files are read through their conversation, so that is the lookup.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_files_conversation")
                    .table(Files::Table)
                    .col(Files::ConversationId)
                    .to_owned(),
            )
            .await?;

        // One folder per key per space, so "find or create" cannot race into two.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_files_system_key_unique")
                    .table(Files::Table)
                    .col(Files::SpaceId)
                    .col(Files::SystemKey)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .drop_column(Users::AvatarFileId)
                    .add_column(ColumnDef::new(Users::AvatarKey).text().null())
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Spaces::Table)
                    .drop_column(Spaces::IconFileId)
                    .add_column(ColumnDef::new(Spaces::IconKey).text().null())
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Restoring these two columns has to restore their foreign keys as well. Dropping a column
        // in `up` takes its constraint with it, so recreating the bare column would leave the
        // migrations that own them (`m20260902_000004` and `m20260902_000005`) unable to drop
        // `fk_users_avatar_file` / `fk_spaces_icon_file` on their own way down, and the round trip
        // fails there rather than here.
        manager
            .alter_table(
                Table::alter()
                    .table(Spaces::Table)
                    .drop_column(Spaces::IconKey)
                    .add_column(ColumnDef::new(Spaces::IconFileId).uuid().null())
                    .to_owned(),
            )
            .await?;
        manager
            .create_foreign_key(
                ForeignKey::create()
                    .name("fk_spaces_icon_file")
                    .from(Spaces::Table, Spaces::IconFileId)
                    .to(Files::Table, Files::Id)
                    .on_delete(ForeignKeyAction::SetNull)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .drop_column(Users::AvatarKey)
                    .add_column(ColumnDef::new(Users::AvatarFileId).uuid().null())
                    .to_owned(),
            )
            .await?;
        manager
            .create_foreign_key(
                ForeignKey::create()
                    .name("fk_users_avatar_file")
                    .from(Users::Table, Users::AvatarFileId)
                    .to(Files::Table, Files::Id)
                    .on_delete(ForeignKeyAction::SetNull)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .name("idx_files_system_key_unique")
                    .table(Files::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .name("idx_files_conversation")
                    .table(Files::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Files::Table)
                    .drop_foreign_key(Alias::new("fk_files_conversation"))
                    .drop_column(Files::SystemKey)
                    .drop_column(Files::ConversationId)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Files {
    Table,
    /// Referenced by the two foreign keys `down` restores.
    Id,
    SpaceId,
    ConversationId,
    SystemKey,
}

/// Local reference to `conversations` (owned by the spaces-and-channels migration).
#[derive(DeriveIden)]
enum Conversations {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    AvatarFileId,
    AvatarKey,
}

#[derive(DeriveIden)]
enum Spaces {
    Table,
    IconFileId,
    IconKey,
}
