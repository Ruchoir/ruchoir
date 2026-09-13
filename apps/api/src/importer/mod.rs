//! Bringing a workspace over from another product: the consuming half of the chain.
//!
//! The producing half lives in `packages/importer` and hands over an archive described in
//! `docs/import-archive.md`. This module reads that archive, tells an administrator exactly what
//! would happen, and (in the slices that follow) makes it happen.

pub mod archive;
pub mod check;

use std::path::Path;

/// `ruchoir-api import-check <archive> [passphrase]`: reads an archive and says whether it holds
/// together, without touching the database.
///
/// It exists for the administrator who has just produced an export and wants to know, before
/// uploading gigabytes, that it will be accepted. It is also how we run the real fixtures through
/// the same checks the import will apply.
pub fn check_command(path: &Path, passphrase: Option<&str>) -> Result<(), String> {
    let (index, report) = check::check(path, passphrase).map_err(|e| e.to_string())?;

    if let Some(manifest) = &index.manifest {
        println!(
            "{} export, produced by {}",
            manifest.source, manifest.producer
        );
        if !manifest.source_version.is_empty() {
            println!("  source:   {}", manifest.source_version);
        }
        if !manifest.created_at.is_empty() {
            println!("  made on:  {}", manifest.created_at);
        }
    }

    println!("\nwhat would be imported");
    for space in &index.spaces {
        let conversations: Vec<_> = index
            .channels
            .iter()
            .filter(|c| c.space == space.id)
            .collect();
        let channels = conversations.iter().filter(|c| c.kind == "channel").count();
        let directs = conversations.len() - channels;
        println!(
            "\n  {} ({}){}",
            space.name,
            space.visibility,
            if space.description.is_empty() {
                String::new()
            } else {
                format!(" - {}", space.description)
            }
        );
        println!("    {channels} channel(s), {directs} direct conversation(s)");
        for conversation in conversations {
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
    let with_address = index.users.iter().filter(|u| !u.email.is_empty()).count();
    let inactive = index.users.iter().filter(|u| !u.active).count();
    println!("\n  {} account(s)", index.users.len());
    println!(
        "    {with_address} with an address, {} without",
        index.users.len() - with_address
    );
    if inactive > 0 {
        println!("    {inactive} deactivated at the source, and will arrive deactivated");
    }
    for user in &index.users {
        println!(
            "      {} <{}>{}",
            user.display_name,
            if user.email.is_empty() {
                "no address"
            } else {
                &user.email
            },
            if user.active { "" } else { " - deactivated" }
        );
    }

    let bytes: i64 = index.files.iter().map(|f| f.size).sum();
    println!("\n  {} message(s)", index.message_count);
    println!("  {} file(s), {} in total", index.files.len(), human(bytes));

    if let Some(manifest) = &index.manifest {
        if !manifest.limits.is_empty() {
            println!("\nwhat this export leaves behind, in its producer's words");
            for limit in &manifest.limits {
                println!("  - {limit}");
            }
        }
    }

    if !report.warnings.is_empty() {
        println!();
        for warning in &report.warnings {
            println!("warning: {warning}");
        }
    }

    if report.is_sound() {
        println!("\nthis archive holds together and would be accepted");
        return Ok(());
    }
    println!();
    for error in &report.errors {
        eprintln!("error: {error}");
    }
    Err(format!(
        "{} problem(s) in {}",
        report.errors.len(),
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
