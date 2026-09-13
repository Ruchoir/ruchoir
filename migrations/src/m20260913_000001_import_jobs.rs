//! Importing a workspace from another product: the job, and what it already brought in.
//!
//! Two tables, and the second is the reason the first can be trusted. `import_jobs` is the managed
//! object an administrator watches: what was uploaded, what it promised, how far it got, why it
//! stopped. `import_mappings` records, for every single entity, which identifier in the source
//! became which row here.
//!
//! That mapping is not bookkeeping, it is the whole safety property. An import of several gigabytes
//! will fail halfway at some point: a network drop, a full disk, an operator who closes the laptop.
//! Written in the same transaction as the row it points at, a mapping makes the archive replayable
//! as-is, because the second run recognises everything the first one already wrote and skips it. No
//! deduplication heuristics, no "did this message already exist" guesswork on content.
//!
//! The uniqueness is per space and per source rather than per job, on purpose. Two archives cut
//! from the same source at two different moments are the ordinary case (a rehearsal, then the real
//! migration the following week), and the second must recognise the first's work. Per job, it would
//! import everything twice.
//!
//! Provenance already exists inline on the imported rows themselves (`imported_source` and
//! `external_ref` on channels, messages and files). Those answer "where does this come from" when
//! looking at one row; this table answers "have I already seen this identifier", which an index on
//! nullable columns spread across three tables cannot do cheaply.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            CREATE TABLE import_jobs (
                id uuid NOT NULL PRIMARY KEY,
                space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                -- Provenance only: the job outlives the account that started it.
                created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
                source text NOT NULL
                    CHECK (source IN ('nextcloud', 'mattermost', 'slack', 'teams')),
                status text NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'analyzing', 'ready', 'running', 'cancelling',
                    'cancelled', 'completed', 'failed'
                )),
                -- What the administrator chose before the run: which channels, whether history,
                -- direct messages and attachments come along, and how unmatched accounts are
                -- handled. JSON text, like the other option bags in the schema.
                options text NOT NULL DEFAULT '{}',
                -- The uploaded archive. NULL once discarded after a completed import.
                archive_file_id uuid NULL REFERENCES files(id) ON DELETE SET NULL,
                -- The archive's own manifest, read at analysis: source version, format version,
                -- counts, and the limits the producing adapter declares about itself.
                manifest text NULL,
                channels_total integer NOT NULL DEFAULT 0,
                channels_done integer NOT NULL DEFAULT 0,
                messages_total integer NOT NULL DEFAULT 0,
                messages_done integer NOT NULL DEFAULT 0,
                files_total integer NOT NULL DEFAULT 0,
                files_done integer NOT NULL DEFAULT 0,
                accounts_total integer NOT NULL DEFAULT 0,
                accounts_done integer NOT NULL DEFAULT 0,
                -- Set only when status is 'failed'. Shown to the administrator as-is, so it is
                -- written for them and never carries an internal backtrace.
                error text NULL,
                started_at timestamptz NULL,
                finished_at timestamptz NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            "#,
        )
        .await?;

        db.execute_unprepared(
            "CREATE INDEX import_jobs_space_created_idx ON import_jobs (space_id, created_at DESC);",
        )
        .await?;

        db.execute_unprepared(
            r#"
            CREATE TABLE import_mappings (
                id uuid NOT NULL PRIMARY KEY,
                job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
                -- Denormalised from the job so the uniqueness below spans every import that space
                -- ever ran, which is what makes a second archive from the same source cheap.
                space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                source text NOT NULL
                    CHECK (source IN ('nextcloud', 'mattermost', 'slack', 'teams')),
                kind text NOT NULL CHECK (kind IN ('user', 'channel', 'message', 'file')),
                -- The identifier as the source spells it, untouched.
                external_ref text NOT NULL,
                internal_id uuid NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            "#,
        )
        .await?;

        // The constraint resumability rests on: one source identifier means one row here,
        // whichever import brought it in.
        db.execute_unprepared(
            "CREATE UNIQUE INDEX import_mappings_identity_idx \
             ON import_mappings (space_id, source, kind, external_ref);",
        )
        .await?;

        // Reporting on a finished job, kind by kind.
        db.execute_unprepared(
            "CREATE INDEX import_mappings_job_kind_idx ON import_mappings (job_id, kind);",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS import_mappings;")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS import_jobs;")
            .await?;
        Ok(())
    }
}
