//! Space invitations: the way an account other than a space's creator gets into it.
//!
//! Unlike the single-use email tokens of the auth core (which live in Valkey, are consumed once and
//! then vanish), an invitation is a managed object: an administrator lists what is outstanding,
//! revokes it, and sees whether it was used. That needs a durable, queryable row, so it lives here.
//!
//! Only the SHA-256 digest of the token is stored, never the token, so a database dump yields no
//! usable invitation. The raw value is returned once at creation and embedded in the invitation
//! email; it cannot be read back out afterwards.
//!
//! One table covers both shapes. An invitation carrying an `email` is addressed to one person; one
//! without is a shareable link. `role` is checked against the same set as `space_members` minus
//! `owner`: ownership is transferred, never handed out by a link.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SpaceInvitations::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SpaceInvitations::Id)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SpaceInvitations::SpaceId).uuid().not_null())
                    // SHA-256 of the token, hex encoded. Unique so a digest addresses one row.
                    .col(
                        ColumnDef::new(SpaceInvitations::TokenHash)
                            .text()
                            .not_null()
                            .unique_key(),
                    )
                    // Set for an invitation addressed to one person; NULL for a shareable link.
                    // citext (created by the auth migration) so the acceptance check ignores case,
                    // exactly like `users.email`.
                    .col(
                        ColumnDef::new(SpaceInvitations::Email)
                            .custom(Alias::new("citext"))
                            .null(),
                    )
                    .col(
                        ColumnDef::new(SpaceInvitations::Role)
                            .text()
                            .not_null()
                            .default("member"),
                    )
                    // Provenance only: the invitation outlives the account that issued it.
                    .col(ColumnDef::new(SpaceInvitations::CreatedBy).uuid().null())
                    // NULL means unlimited, which is the default for a shareable link.
                    .col(ColumnDef::new(SpaceInvitations::MaxUses).integer().null())
                    .col(
                        ColumnDef::new(SpaceInvitations::Uses)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(SpaceInvitations::ExpiresAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(SpaceInvitations::RevokedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(SpaceInvitations::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    // `owner` is deliberately absent: ownership is not something a link can grant.
                    .check(Expr::col(SpaceInvitations::Role).is_in(["admin", "member", "guest"]))
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_space_invitations_space")
                            .from(SpaceInvitations::Table, SpaceInvitations::SpaceId)
                            .to(Spaces::Table, Spaces::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_space_invitations_created_by")
                            .from(SpaceInvitations::Table, SpaceInvitations::CreatedBy)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        // The administration screen lists a space's invitations newest first.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_space_invitations_space")
                    .table(SpaceInvitations::Table)
                    .col(SpaceInvitations::SpaceId)
                    .col(SpaceInvitations::CreatedAt)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SpaceInvitations::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SpaceInvitations {
    Table,
    Id,
    SpaceId,
    TokenHash,
    Email,
    Role,
    CreatedBy,
    MaxUses,
    Uses,
    ExpiresAt,
    RevokedAt,
    CreatedAt,
}

/// Local reference to the `spaces` table (owned by the spaces migration).
#[derive(DeriveIden)]
enum Spaces {
    Table,
    Id,
}

/// Local reference to the `users` table (owned by the auth migration).
#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
