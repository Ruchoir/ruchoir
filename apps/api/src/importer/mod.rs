//! Bringing a workspace over from another product: the consuming half of the chain.
//!
//! The producing half lives in `packages/importer` and hands over an archive described in
//! `docs/import-archive.md`. This module reads that archive, tells an administrator exactly what
//! would happen, and (in the slices that follow) makes it happen.

pub mod archive;
pub mod check;
pub mod drops;
pub mod job;
pub mod plan;
pub mod routes;
pub mod run;
pub mod scripts;
pub mod wipe;

use std::path::Path;

use plan::{AccountOutcome, Existing, Plan};
use sea_orm::DatabaseConnection;

/// `ruchoir-api import-check <archive> [passphrase]`: reads an archive and says whether it holds
/// together, without touching the database.
///
/// It exists for the administrator who has just produced an export and wants to know, before
/// uploading gigabytes, that it will be accepted. It is also how we run the real fixtures through
/// the same checks the import will apply.
pub fn check_command(path: &Path, passphrase: Option<&str>) -> Result<(), String> {
    let (index, report) = check::check(path, passphrase).map_err(|e| e.to_string())?;

    // Nothing to compare against from the command line: on a real instance the same plan is built
    // against what it already holds, and that is what the screen shows.
    let plan: Plan = plan::build(&index, &Existing::default());

    if let Some(manifest) = &index.manifest {
        println!("{} export, produced by {}", plan.source, manifest.producer);
        if !manifest.source_version.is_empty() {
            println!("  source:   {}", manifest.source_version);
        }
        if !manifest.created_at.is_empty() {
            println!("  made on:  {}", manifest.created_at);
        }
    }

    println!("\nwhat would be imported");
    println!(
        "  {} space(s), all of them new to this instance",
        plan.spaces_created()
    );
    for space in &plan.spaces {
        println!(
            "\n  {} - {} channel(s), {} direct conversation(s)",
            space.name, space.channels, space.directs
        );
        if !space.description.is_empty() {
            println!("    {}", first_line(&space.description));
        }
        for conversation in index.channels.iter().filter(|c| c.space == space.source_id) {
            let name = if conversation.name.is_empty() {
                conversation.members.join(", ")
            } else {
                conversation.name.clone()
            };
            let kept = conversation
                .member_state
                .iter()
                .filter(|state| {
                    state.favorite || state.read_at.is_some() || state.read_message.is_some()
                })
                .count();
            println!(
                "      {name} - {} {}, {} member(s){}{}",
                conversation.visibility,
                conversation.kind,
                conversation.members.len(),
                if conversation.archived {
                    ", archived"
                } else {
                    ""
                },
                if kept > 0 {
                    format!(", {kept} with a favourite or a reading position")
                } else {
                    String::new()
                }
            );
            if let Some(created) = &conversation.created_at {
                println!("        opened {created}");
            }
            if !conversation.topic.is_empty() {
                println!("        topic: {}", first_line(&conversation.topic));
            }
        }
    }

    // Accounts are the part an administrator has to look at hardest: an address is what the import
    // matches on, and an account without one needs a decision rather than a guess.
    let invited = plan.accounts_with(AccountOutcome::Invited);
    let undecidable = plan.accounts_with(AccountOutcome::NeedsDecision);
    let inactive = plan.accounts.iter().filter(|a| !a.active).count();
    println!("\n  {} account(s)", plan.accounts.len());
    println!("    {invited} could be invited by mail, {undecidable} have no address at all");
    if inactive > 0 {
        println!("    {inactive} deactivated at the source, and will arrive deactivated");
    }
    if !plan.anyone_reachable_by_mail() && !plan.accounts.is_empty() {
        println!(
            "    nobody here can be reached by mail: every person will need a link handed to them"
        );
    }
    for account in &plan.accounts {
        // The source identifier is shown next to the person: on an instance with no addresses it
        // is the only thing an administrator has to match someone by hand.
        println!(
            "      {:<12} {} <{}>{}",
            account.source_id,
            account.display_name,
            if account.email.is_empty() {
                "no address"
            } else {
                &account.email
            },
            if account.active { "" } else { " - deactivated" }
        );
    }

    println!("\n  {} message(s)", plan.messages);
    println!("  {} file(s), {} in total", plan.files, human(plan.bytes));

    if !plan.limits.is_empty() {
        println!("\nwhat this export leaves behind, in its producer's words");
        for limit in &plan.limits {
            println!("  - {limit}");
        }
    }

    let warnings = report.warnings();
    if !warnings.is_empty() {
        println!();
        for warning in &warnings {
            println!("warning: {warning}");
        }
    }

    if report.is_sound() {
        println!("\nthis archive holds together and would be accepted");
        return Ok(());
    }
    println!();
    for error in &report.errors() {
        eprintln!("error: {error}");
    }
    Err(format!(
        "{} problem(s) in {}",
        report.error_count(),
        path.display()
    ))
}

/// A topic can be a page of Markdown; a listing shows the first line of it.
fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default();
    if line.chars().count() > 70 {
        format!("{}...", line.chars().take(70).collect::<String>())
    } else {
        line.to_string()
    }
}

fn human(bytes: i64) -> String {
    const UNITS: [&str; 4] = ["B", "kB", "MB", "GB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

/// `ruchoir-api import <archive> <administrator address> [passphrase]`: runs a whole import from a
/// file already on the server.
///
/// The other way in is the screen, which an administrator uses for an archive small enough to
/// upload. This one exists for the case the screen cannot serve: sixty gigabytes that came over on
/// a disk, on a machine the administrator already has a shell on.
///
/// The address is asked for rather than guessed: whoever runs the import owns every space it
/// creates, and picking "the first administrator" would quietly hand a company's workspaces to
/// whoever happened to be created first.
pub async fn import_command(
    db: &DatabaseConnection,
    storage: Option<&crate::storage::S3Store>,
    archive: &Path,
    admin_email: &str,
    passphrase: Option<&str>,
) -> Result<(), String> {
    use crate::entities::users;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

    let admin = users::Entity::find()
        .filter(users::Column::Email.eq(admin_email.trim().to_lowercase()))
        .one(db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no account here has the address {admin_email}"))?;
    if !admin.is_instance_admin {
        return Err(format!(
            "{admin_email} is not an administrator of this instance, and an import creates \
             accounts and spaces"
        ));
    }

    println!("importing {} as {}", archive.display(), admin.display_name);
    let outcome = job::execute(db, storage, archive, passphrase, admin.id)
        .await
        .map_err(|e| e.to_string())?;

    let written = outcome.written;
    println!("\ndone");
    println!(
        "  {} space(s) created, {} filled",
        written.spaces_created, written.spaces_filled
    );
    println!(
        "  {} account(s) created, {} recognised",
        written.accounts_created, written.accounts_matched
    );
    println!(
        "  {} conversation(s) created, {} filled",
        written.conversations_created, written.conversations_filled
    );
    println!("  {} message(s)", written.messages_created);
    println!("  {} file(s)", written.files_created);
    println!("  {} reading position(s) restored", written.read_positions);

    if !outcome.limits.is_empty() {
        // The same sentences the administrator read before starting: what did not come over, in
        // the producer's own words, said again at the end rather than only at the beginning.
        println!("\nwhat this export left behind");
        for limit in &outcome.limits {
            println!("  - {limit}");
        }
    }

    println!(
        "\nEveryone arrived without a password, waiting for their invitation. Nobody has been \
         emailed: sending is a separate step."
    );
    Ok(())
}
