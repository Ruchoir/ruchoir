//! The engine against the old rules: over every combination the old rules tell apart, the engine
//! must decide exactly what they decided. The data goes through the migration's own conversion
//! first, so what is compared is what production will run on.

use super::permissions_tests::{join_as, ladder, reserve, space_calendar};
use super::*;

use crate::entities::calendars;
use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Resource};

mod legacy_rules;
use legacy_rules::*;

const KINDS: [&str; 3] = ["public", "private", "archived"];
const RESERVATIONS: [&[&str]; 4] = [&[], &["admin"], &["member", "guest"], &["guest"]];
const CHANNEL_ROLES_OR_NONE: [Option<&str>; 4] =
    [None, Some("member"), Some("admin"), Some("owner")];

struct ChannelCase {
    id: Uuid,
    label: String,
    archived: bool,
    joined: bool,
}

struct FileCase {
    id: Uuid,
    label: String,
}

/// Collects every difference rather than stopping at the first, so one run shows them all.
#[derive(Default)]
struct Differences(Vec<String>);

impl Differences {
    fn compare(&mut self, what: &str, who: &str, case: &str, legacy: bool, engine: bool) {
        if legacy != engine {
            self.0.push(format!(
                "{who} / {case} / {what}: old rules {legacy}, engine {engine}"
            ));
        }
    }
}

async fn file(
    db: &DatabaseConnection,
    space_id: Uuid,
    author: Uuid,
    conversation: Option<Uuid>,
) -> Uuid {
    let id = Uuid::new_v4();
    files::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        name: Set(format!("doc-{}.txt", id.simple())),
        kind: Set("file".to_owned()),
        owner_id: Set(Some(author)),
        conversation_id: Set(conversation),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("file");
    id
}

/// A space-tree file posted as an attachment in a conversation, the way a public channel's
/// attachments are stored.
async fn attached(
    db: &DatabaseConnection,
    space_id: Uuid,
    author: Uuid,
    conversation: Uuid,
) -> Uuid {
    let id = file(db, space_id, author, None).await;
    let message = Uuid::new_v4();
    messages::ActiveModel {
        id: Set(message),
        conversation_id: Set(conversation),
        author_id: Set(Some(author)),
        kind: Set("message".to_owned()),
        body: Set("ci-joint".to_owned()),
        created_at: Set(OffsetDateTime::now_utc()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("message");
    message_attachments::ActiveModel {
        message_id: Set(message),
        file_id: Set(id),
        position: Set(0),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("attachment");
    id
}

async fn direct_message(db: &DatabaseConnection, space_id: Uuid, people: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    conversations::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        kind: Set("direct".to_owned()),
        created_at: Set(OffsetDateTime::now_utc()),
    }
    .insert(db)
    .await
    .expect("conversation");
    dm_conversations::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        is_group: Set(people.len() > 2),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("dm");
    for person in people {
        dm_participants::ActiveModel {
            dm_id: Set(id),
            user_id: Set(*person),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("participant");
    }
    id
}

#[tokio::test]
async fn the_engine_decides_what_the_old_rules_decided() {
    let Some(app) = boot().await else { return };
    let db = &app.db;
    let fx = ladder(db).await;
    let space = fx.space_id;
    let people = [
        ("owner", fx.owner),
        ("admin", fx.admin),
        ("member", fx.member),
        ("guest", fx.guest),
    ];

    // Every channel the old rules tell apart, everybody in the same position in each.
    let mut channels = Vec::new();
    let mut file_cases = Vec::new();
    for kind in KINDS {
        for reservation in RESERVATIONS {
            for channel_role in CHANNEL_ROLES_OR_NONE {
                let label = format!(
                    "{kind} channel reserved to {reservation:?}, joined as {channel_role:?}"
                );
                let id = make_channel(db, space, &format!("c{}", channels.len()), kind).await;
                reserve(db, id, reservation).await;
                if let Some(role) = channel_role {
                    for (_, person) in people {
                        join_as(db, id, person, role).await;
                    }
                }
                // Its files (the channel role changes nothing for files): carried by the channel,
                // and in the space tree with a message in the channel, by each author.
                if matches!(channel_role, None | Some("member")) {
                    for (author_name, author) in people {
                        file_cases.push(FileCase {
                            id: file(db, space, author, Some(id)).await,
                            label: format!("file of {author_name} carried by the {label}"),
                        });
                        file_cases.push(FileCase {
                            id: attached(db, space, author, id).await,
                            label: format!("tree file of {author_name} attached in the {label}"),
                        });
                    }
                }
                channels.push(ChannelCase {
                    id,
                    label,
                    archived: kind == "archived",
                    joined: channel_role.is_some(),
                });
            }
        }
    }
    let dm = direct_message(db, space, &[fx.admin, fx.guest]).await;
    for (author_name, author) in people {
        file_cases.push(FileCase {
            id: file(db, space, author, Some(dm)).await,
            label: format!("file of {author_name} in a DM between admin and guest"),
        });
        file_cases.push(FileCase {
            id: file(db, space, author, None).await,
            label: format!("tree file of {author_name}"),
        });
    }
    let mut calendar_cases = Vec::new();
    for write in ["members", "admins"] {
        let id = space_calendar(db, space, write).await;
        let model = calendars::Entity::find_by_id(id)
            .one(db)
            .await
            .expect("calendar")
            .expect("row");
        calendar_cases.push((format!("calendar written by {write}"), id, model));
    }

    // The migration's own conversion, so the engine reads what production will hold.
    ruchoir_migration::m20261104_000001_permissions_foundation::convert_space(db, space)
        .await
        .expect("convert");

    let mut diff = Differences::default();
    for (who, person) in people {
        let guest = legacy_is_guest(db, space, person).await.expect("guest");
        let in_space = check::effective(db, space, person, Resource::Space)
            .await
            .expect("space");
        let admin = legacy_ensure_space_admin(db, space, person).await.is_ok();
        for (what, permission) in [
            ("invite", Permission::MembersInvite),
            ("remove members", Permission::MembersManage),
            ("change roles", Permission::RolesManage),
            ("space settings", Permission::SpaceSettings),
            ("delete channels", Permission::ChannelsDelete),
            ("create calendars", Permission::CalendarsCreate),
            ("empty the trash", Permission::FilesTrashPurge),
        ] {
            diff.compare(what, who, "space", admin, in_space.contains(permission));
        }
        diff.compare(
            "create a channel",
            who,
            "space",
            !guest,
            in_space.contains(Permission::ChannelsCreate),
        );
        diff.compare(
            "see every member",
            who,
            "space",
            !guest,
            in_space.contains(Permission::MembersView),
        );
        let files_member = legacy_ensure_space_files_member(db, space, person)
            .await
            .is_ok();
        for (what, permission) in [
            ("space files", Permission::FilesView),
            ("upload to the space", Permission::FilesCreate),
        ] {
            diff.compare(
                what,
                who,
                "space",
                files_member,
                in_space.contains(permission),
            );
        }

        // The messaging questions rebuilt on the engine, against their old selves.
        let sorted = |mut ids: Vec<Uuid>| {
            ids.sort();
            ids
        };
        diff.compare(
            "members shown",
            who,
            "space",
            true,
            sorted(
                legacy_visible_member_ids(db, space, person)
                    .await
                    .expect("legacy"),
            ) == sorted(
                crate::messaging::authz::visible_member_ids(db, space, person)
                    .await
                    .expect("engine"),
            ),
        );
        diff.compare(
            "conversations searched",
            who,
            "space",
            true,
            sorted(
                legacy_accessible_conversation_ids(db, space, person)
                    .await
                    .expect("legacy"),
            ) == sorted(
                crate::messaging::authz::accessible_conversation_ids(db, space, person)
                    .await
                    .expect("engine"),
            ),
        );
        for case in &channels {
            let legacy_rank = legacy_effective_channel_rank(db, case.id, space, person)
                .await
                .expect("legacy rank");
            let rank = crate::messaging::authz::effective_channel_rank(db, case.id, space, person)
                .await
                .expect("rank");
            diff.compare(
                "rank in the channel",
                who,
                &case.label,
                true,
                legacy_rank == rank,
            );
            diff.compare(
                "admitted by the reservation",
                who,
                &case.label,
                legacy_role_admitted(db, case.id, space, person)
                    .await
                    .expect("legacy"),
                crate::messaging::authz::role_admitted(db, case.id, space, person)
                    .await
                    .expect("engine"),
            );
        }

        for case in &channels {
            let got = check::effective(db, space, person, Resource::Channel(case.id))
                .await
                .expect("channel");
            let view = got.contains(Permission::ChannelView);
            let access = legacy_ensure_conversation_access(db, case.id, person)
                .await
                .is_ok();
            diff.compare("read", who, &case.label, access, view);
            let moderator = legacy_is_channel_moderator(db, case.id, space, person)
                .await
                .expect("moderator");
            for (what, permission) in [
                ("delete others' messages", Permission::MessageManage),
                ("add and remove people", Permission::ChannelMembersManage),
                ("rename and archive", Permission::ChannelManage),
            ] {
                diff.compare(what, who, &case.label, moderator, got.contains(permission));
            }
            let postable = access && !case.archived;
            for (what, permission) in [
                ("send", Permission::MessageSend),
                ("attach", Permission::MessageAttach),
            ] {
                diff.compare(
                    what,
                    who,
                    &case.label,
                    postable,
                    view && got.contains(permission),
                );
            }
            diff.compare(
                "react",
                who,
                &case.label,
                access,
                view && got.contains(Permission::MessageReact),
            );
            diff.compare(
                "pin",
                who,
                &case.label,
                access && !guest && case.joined,
                view && got.contains(Permission::MessagePin) && case.joined,
            );
        }

        for case in &file_cases {
            let got = check::effective(db, space, person, Resource::File(case.id))
                .await
                .expect("file");
            let legacy = legacy_ensure_readable(db, case.id, person).await;
            let readable = legacy.is_ok();
            let (can_edit, in_conversation) = legacy
                .map(|access| (access.can_edit, access.file.conversation_id.is_some()))
                .unwrap_or((false, false));
            let content = legacy_ensure_content_editable(db, case.id, person)
                .await
                .is_ok();
            // The files guards rebuilt on the engine, against their old selves.
            let rebuilt = crate::files::authz::ensure_readable(db, case.id, person).await;
            diff.compare(
                "ensure_readable",
                who,
                &case.label,
                readable,
                rebuilt.is_ok(),
            );
            diff.compare(
                "can_edit",
                who,
                &case.label,
                can_edit,
                rebuilt.map(|access| access.can_edit).unwrap_or(false),
            );
            diff.compare(
                "ensure_content_editable",
                who,
                &case.label,
                content,
                crate::files::authz::ensure_content_editable(db, case.id, person)
                    .await
                    .is_ok(),
            );
            diff.compare(
                "read",
                who,
                &case.label,
                readable,
                got.contains(Permission::FilesView),
            );
            diff.compare(
                "rename, move, delete",
                who,
                &case.label,
                can_edit,
                got.contains(Permission::FilesManage),
            );
            diff.compare(
                "edit the content",
                who,
                &case.label,
                content,
                got.contains(Permission::FilesEdit),
            );
            diff.compare(
                "publish a link",
                who,
                &case.label,
                can_edit && !in_conversation && files_member,
                got.contains(Permission::FilesPublicLink),
            );
        }

        for (label, id, model) in &calendar_cases {
            let got = check::effective(db, space, person, Resource::Calendar(*id))
                .await
                .expect("calendar");
            let (seen, write, manage) = match legacy_seeing_role(db, space, person)
                .await
                .expect("seeing role")
            {
                Some(role) => {
                    let (write, manage) = legacy_calendar_rights(model, Some(role));
                    (true, write, manage)
                }
                None => (false, false, false),
            };
            diff.compare(
                "see",
                who,
                label,
                seen,
                got.contains(Permission::CalendarView),
            );
            diff.compare(
                "write events",
                who,
                label,
                write,
                got.contains(Permission::CalendarWrite),
            );
            diff.compare(
                "manage",
                who,
                label,
                manage,
                got.contains(Permission::CalendarManage),
            );
        }
    }
    let checked = channels.len() + file_cases.len() + calendar_cases.len();
    assert!(
        diff.0.is_empty(),
        "{} differences over {checked} resources:\n{}",
        diff.0.len(),
        diff.0.join("\n")
    );
    // Not vacuous: the matrix really holds people who may and may not.
    assert!(checked > 200);
}
