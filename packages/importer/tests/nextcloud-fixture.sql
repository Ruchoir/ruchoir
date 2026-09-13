-- A Nextcloud, reduced to what the export script reads.
--
-- Not a dump of a real instance: only the tables and columns the producer touches, filled with the
-- cases that have already broken it once. Every row here exists because something went wrong
-- without it.
--
-- Loaded into a scratch database by tests/test_export_nextcloud.py.

DROP TABLE IF EXISTS oc_users, oc_accounts, oc_preferences, oc_talk_rooms, oc_talk_attendees,
                     oc_comments, oc_reactions, oc_share, oc_filecache, oc_storages, oc_appconfig;

CREATE TABLE oc_users (
  uid varchar(64) NOT NULL PRIMARY KEY,
  displayname varchar(64) DEFAULT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_accounts (
  uid varchar(64) NOT NULL PRIMARY KEY,
  data longtext NOT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_preferences (
  userid varchar(64) NOT NULL,
  appid varchar(32) NOT NULL,
  configkey varchar(64) NOT NULL,
  configvalue longtext
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_talk_rooms (
  id bigint unsigned NOT NULL PRIMARY KEY,
  name varchar(255) DEFAULT '',
  token varchar(32) DEFAULT '',
  type int NOT NULL,
  description longtext DEFAULT '',
  object_type varchar(64) DEFAULT '',
  active_since datetime DEFAULT NULL,
  last_activity datetime DEFAULT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_talk_attendees (
  id bigint NOT NULL PRIMARY KEY,
  room_id bigint unsigned NOT NULL,
  actor_type varchar(32) NOT NULL,
  actor_id varchar(255) NOT NULL,
  favorite tinyint(1) DEFAULT 0,
  last_read_message bigint DEFAULT 0
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_comments (
  id bigint unsigned NOT NULL PRIMARY KEY,
  parent_id bigint unsigned NOT NULL DEFAULT 0,
  actor_type varchar(64) NOT NULL DEFAULT '',
  actor_id varchar(64) NOT NULL DEFAULT '',
  message longtext DEFAULT NULL,
  verb varchar(64) DEFAULT NULL,
  creation_timestamp datetime DEFAULT NULL,
  object_type varchar(64) NOT NULL DEFAULT '',
  object_id varchar(64) NOT NULL DEFAULT '',
  reactions varchar(4000) DEFAULT NULL,
  meta_data longtext DEFAULT ''
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_reactions (
  id bigint unsigned NOT NULL PRIMARY KEY,
  parent_id bigint unsigned NOT NULL,
  actor_type varchar(64) NOT NULL DEFAULT '',
  actor_id varchar(64) NOT NULL DEFAULT '',
  reaction varchar(32) NOT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_share (
  id bigint NOT NULL PRIMARY KEY,
  share_type int NOT NULL,
  uid_owner varchar(64) DEFAULT NULL,
  file_source bigint DEFAULT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_filecache (
  fileid bigint NOT NULL PRIMARY KEY,
  storage bigint NOT NULL,
  path varchar(4000) DEFAULT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_storages (
  numeric_id bigint NOT NULL PRIMARY KEY,
  id varchar(64) NOT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE oc_appconfig (
  appid varchar(32) NOT NULL,
  configkey varchar(64) NOT NULL,
  configvalue longtext
) DEFAULT CHARSET=utf8mb4;

-- Accounts: one with an address, one without (an instance with no mail server has none), and one
-- disabled through the preference the export reads.
INSERT INTO oc_users (uid, displayname) VALUES
  ('alice', 'Alice Martin'), ('bob', 'Bob Durand'), ('carol', 'Carol'), ('emma', 'Emma');
INSERT INTO oc_accounts (uid, data) VALUES
  ('alice', '{"email":{"value":"alice@example.org"}}'),
  ('bob', '{"email":{"value":""}}'),
  ('carol', '{"email":{"value":"carol@example.org"}}'),
  ('emma', '{"email":{"value":"emma@example.org"}}');
INSERT INTO oc_preferences (userid, appid, configkey, configvalue) VALUES
  ('emma', 'core', 'enabled', 'false');

-- Conversations. Types: 1 one-to-one, 2 group, 3 public, 4 changelog, 6 note to self. The last
-- two, plus anything flagged `sample`, are Nextcloud's own furniture and must not cross.
INSERT INTO oc_talk_rooms (id, name, token, type, description, object_type, active_since, last_activity) VALUES
  (1, 'Général', 'tokgeneral', 3, 'le canal ouvert', '', '2026-09-01 09:00:00', '2026-09-02 09:00:00'),
  (2, 'Équipe', 'tokequipe', 2, '', '', NULL, '2026-09-02 10:00:00'),
  (3, 'alice-bob', 'tokdirect', 1, '', '', '2026-09-01 11:00:00', NULL),
  (4, 'changelog', 'tokchangelog', 4, '', '', NULL, NULL),
  (5, 'Note to self', 'toknote', 6, '', 'note_to_self', NULL, NULL),
  (6, 'Exemple', 'toksample', 2, '', 'sample', NULL, NULL);

INSERT INTO oc_talk_attendees (id, room_id, actor_type, actor_id, favorite, last_read_message) VALUES
  (1, 1, 'users', 'alice', 1, 101),
  (2, 1, 'users', 'bob', 0, 102),
  (3, 1, 'users', 'carol', 0, 0),
  (4, 2, 'users', 'alice', 0, 0),
  (5, 2, 'users', 'bob', 0, 0),
  (6, 3, 'users', 'alice', 0, 0),
  (7, 3, 'users', 'bob', 0, 0),
  (8, 6, 'users', 'alice', 0, 0),
  -- A guest attendee: not an account, and must not end up in the roster.
  (9, 1, 'guests', 'sample', 0, 0);

-- Messages.
INSERT INTO oc_comments (id, parent_id, actor_type, actor_id, message, verb, creation_timestamp, object_type, object_id, reactions, meta_data) VALUES
  -- Plain, with emoji and accents: the utf8mb3 bug destroyed both.
  (101, 0, 'users', 'alice', 'Bonjour 🎉 à toutes et à tous', 'comment', '2026-09-01 09:05:00', 'chat', '1', NULL, '{"can_mention_all":true}'),
  -- Pinned, which Talk keeps in meta_data and not in a column.
  (102, 0, 'users', 'bob', 'Message épinglé', 'comment', '2026-09-01 09:06:00', 'chat', '1', '{"👍":1}', '{"pinned_at":1789299686,"pinned_id":110}'),
  -- A reply: the closest thing Talk has to a thread.
  (103, 102, 'users', 'carol', 'Une réponse', 'comment', '2026-09-01 09:07:00', 'chat', '1', NULL, '{}'),
  -- Written by a guest: kept, marked absent, never dropped.
  (104, 0, 'guests', 'sample', 'Un message d''invité', 'comment', '2026-09-01 09:08:00', 'chat', '1', NULL, '{}'),
  -- A shared file, which is how an attachment appears in a conversation.
  (105, 0, 'users', 'alice', '{"message":"file_shared","parameters":{"share":"7"}}', 'object_shared', '2026-09-01 09:09:00', 'chat', '1', NULL, '{}'),
  -- Notices: the two that map, and two that must be dropped.
  (106, 0, 'users', 'system', '{"message":"conversation_created","parameters":[]}', 'system', '2026-09-01 09:00:00', 'chat', '1', NULL, '{}'),
  (107, 0, 'users', 'alice', '{"message":"user_added","parameters":{"user":"bob"}}', 'system', '2026-09-01 09:01:00', 'chat', '1', NULL, '{}'),
  (108, 0, 'users', 'alice', '{"message":"moderator_promoted","parameters":{"user":"bob"}}', 'system', '2026-09-01 09:02:00', 'chat', '1', NULL, '{}'),
  (109, 0, 'users', 'alice', '{"message":"message_pinned","parameters":{"message":"102"}}', 'system', '2026-09-01 09:06:30', 'chat', '1', NULL, '{}'),
  -- A deleted message: a tombstone, not a text.
  (110, 0, 'users', 'bob', 'Message supprimé', 'comment_deleted', '2026-09-01 09:10:00', 'chat', '1', NULL, '{}'),
  -- A reaction row, which is a comment of its own and must not become a message.
  (111, 102, 'users', 'alice', '👍', 'reaction', '2026-09-01 09:06:10', 'chat', '1', NULL, '{}'),
  -- In the other conversations, including the furniture that must not cross.
  (112, 0, 'users', 'alice', 'Dans l''équipe', 'comment', '2026-09-02 10:00:00', 'chat', '2', NULL, '{}'),
  (113, 0, 'users', 'alice', 'En direct', 'comment', '2026-09-01 11:05:00', 'chat', '3', NULL, '{}'),
  (114, 0, 'guests', 'changelog', 'Nouveautés de Talk', 'comment', '2026-09-01 08:00:00', 'chat', '4', NULL, '{}'),
  (115, 0, 'users', 'alice', 'Ma note', 'comment', '2026-09-01 08:30:00', 'chat', '5', NULL, '{}'),
  (116, 0, 'guests', 'sample', 'Bienvenue dans Talk', 'comment', '2026-09-01 08:45:00', 'chat', '6', NULL, '{}');

-- Who reacted: the counts on the message say nothing useful.
INSERT INTO oc_reactions (id, parent_id, actor_type, actor_id, reaction) VALUES
  (1, 102, 'users', 'alice', '👍'),
  (2, 102, 'users', 'carol', '👍'),
  (3, 102, 'users', 'bob', '🎉');

-- The chain a shared file goes through: share -> filecache -> storages -> <account>/<path>.
INSERT INTO oc_share (id, share_type, uid_owner, file_source) VALUES (7, 10, 'alice', 42);
INSERT INTO oc_filecache (fileid, storage, path) VALUES (42, 3, 'files/Documents/note.txt');
INSERT INTO oc_storages (numeric_id, id) VALUES (3, 'home::alice'), (1, 'local::/var/www/html/data/');

INSERT INTO oc_appconfig (appid, configkey, configvalue) VALUES ('spreed', 'installed_version', '24.0.4');
