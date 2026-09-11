//! Ruchoir database migrations, applied in order by [`Migrator`].
//!
//! Migrations are versioned and forward-only: never edit one that has shipped, add a new one.
//! The API applies them automatically in development and through the explicit `migrate`
//! subcommand in production (see `apps/api`).

pub use sea_orm_migration::prelude::*;

mod m20260901_000001_init_auth;
mod m20260902_000001_spaces_and_channels;
mod m20260902_000002_files;
mod m20260902_000003_messaging;
mod m20260902_000004_user_profiles;
mod m20260902_000005_preferences_and_media;
mod m20260903_000001_user_manual_presence;
mod m20260903_000002_file_thumbnails;
mod m20260904_000001_search_and_notifications;
mod m20260907_000001_space_invitations;
mod m20260907_000002_user_uploads;
mod m20260907_000003_space_slug_history;
mod m20260911_000001_broadcast_notification_kind;

/// The ordered list of migrations. New migrations are appended here.
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260901_000001_init_auth::Migration),
            Box::new(m20260902_000001_spaces_and_channels::Migration),
            Box::new(m20260902_000002_files::Migration),
            Box::new(m20260902_000003_messaging::Migration),
            Box::new(m20260902_000004_user_profiles::Migration),
            Box::new(m20260902_000005_preferences_and_media::Migration),
            Box::new(m20260903_000001_user_manual_presence::Migration),
            Box::new(m20260903_000002_file_thumbnails::Migration),
            Box::new(m20260904_000001_search_and_notifications::Migration),
            Box::new(m20260907_000001_space_invitations::Migration),
            Box::new(m20260907_000002_user_uploads::Migration),
            Box::new(m20260907_000003_space_slug_history::Migration),
            Box::new(m20260911_000001_broadcast_notification_kind::Migration),
        ]
    }
}
