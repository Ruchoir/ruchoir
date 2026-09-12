"use client";

import { useEffect, useState } from "react";
import { Avatar, Button, Checkbox, Dialog, Field, Input, Radio, Select, Switch } from "@/components/ds";
import type { Presence } from "@/components/ds";
import { getAvatar, getChannelMembers } from "@/lib/data";
import { addChannelMembers, listChannelMembers } from "@/lib/data/api";
import type { Channel, ChannelType } from "@/lib/data";
import type { ChannelNotifPref, NotifLevel } from "../app/notifications";
import type { Toast } from "../app/types";
import { ChannelRoleAccess } from "./ChannelRoleAccess";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";

/** Channel roles, as dictionary keys. */
/** The roles a channel member can hold, as dictionary keys: translated where the select is drawn. */
const CHANNEL_ROLES: TranslationKey[] = [key("role.member"), key("channel.moderator"), key("role.admin")];

/** Edit a channel's name, topic, visibility and (for private channels) member access and roles. */
export function ChannelSettingsDialog({
  channel,
  onClose,
  onUpdate,
  onNotify,
  myRole,
}: {
  channel: Channel;
  onClose: () => void;
  onUpdate: (patch: Partial<Channel>) => void;
  onNotify: (toast: Toast) => void;
  /** The caller's own space role: always admitted, and what the reservation is checked against. */
  myRole: string;
}) {
  const { t } = useTranslation();
  const members = getChannelMembers();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [type, setType] = useState<ChannelType>(channel.type === "archived" ? "public" : channel.type);
  const [archived, setArchived] = useState(channel.type === "archived");
  const [allowedRoles, setAllowedRoles] = useState<string[] | undefined>(channel.allowedRoles);
  // Every member has access by default; toggled per member for private channels.
  const [access, setAccess] = useState<Set<string>>(() => new Set(members.map((m) => m.name)));

  const isPrivate = type === "private" && !archived;

  const toggleAccess = (memberName: string) =>
    setAccess((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(memberName)) nextSet.delete(memberName);
      else nextSet.add(memberName);
      return nextSet;
    });

  const save = () => {
    const clean = name.trim().replace(/^#/, "");
    onUpdate({
      name: clean || channel.name,
      topic: topic.trim(),
      type: archived ? "archived" : type,
      // An empty list and no list say the same thing to the API: this channel admits everyone.
      allowedRoles: allowedRoles ?? [],
    });
    onNotify({ tone: "success", title: t("channel.updated"), description: `#${clean || channel.name}` });
    onClose();
  };

  return (
    <Dialog
      title={t("sidebar.channelSettings")}
      closeLabel={t("common.close")}
      size={isPrivate ? "md" : "sm"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label={t("channel.name")} htmlFor="cs-name">
          <Input id="cs-name" icon="hash" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("channel.topic")} optional htmlFor="cs-topic">
          <Input id="cs-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("channel.topicPlaceholder")} />
        </Field>
        <Field label={t("channel.visibility")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Radio name="cs-type" checked={type === "public"} disabled={archived} onChange={() => setType("public")} label={t("channel.public")} description={t("channel.publicHint")} />
            <Radio name="cs-type" checked={type === "private"} disabled={archived} onChange={() => setType("private")} label={t("channel.private")} description={t("channel.privateHint")} />
          </div>
        </Field>
        <ChannelRoleAccess value={allowedRoles} onChange={setAllowedRoles} myRole={myRole} />

        {isPrivate ? (
          <Field label={t("channel.membersAndAccess", { count: access.size })}>
            <div
              style={{
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md)",
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {members.map((m, i) => {
                const has = access.has(m.name);
                return (
                  <div
                    key={m.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderTop: i ? "1px solid var(--border-subtle)" : "none",
                    }}
                  >
                    <Checkbox checked={has} onChange={() => toggleAccess(m.name)} aria-label={t("channel.accessOf", { name: m.name })} />
                    <Avatar name={m.name} src={m.avatar} size={26} presence={m.presence} kind={m.bot ? "bot" : "person"} />
                    <span style={{ flex: 1, fontSize: 13, color: has ? "var(--text-strong)" : "var(--text-muted)" }}>{m.name}</span>
                    <div style={{ width: 150 }}>
                      <Select
                        size="sm"
                        options={CHANNEL_ROLES.map((r) => ({ value: r as unknown as string, label: t(r) }))}
                        disabled={!has}
                        defaultValue={CHANNEL_ROLES[0] as unknown as string}
                        aria-label={t("channel.roleOf", { name: m.name })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Field>
        ) : null}

        <Switch checked={archived} onChange={() => setArchived((a) => !a)} label={t("channel.archive")} reverse />
      </div>
    </Dialog>
  );
}

/** Per-channel notification preferences. Controlled: the current preference is persisted in AppRoot. */
export function ChannelNotificationsDialog({
  channelName,
  isDm = false,
  value,
  onClose,
  onSave,
  onNotify,
}: {
  channelName: string;
  isDm?: boolean;
  value: ChannelNotifPref;
  onClose: () => void;
  onSave: (pref: ChannelNotifPref) => void;
  onNotify: (toast: Toast) => void;
}) {
  const { t } = useTranslation();
  const [level, setLevel] = useState<NotifLevel>(value.level);
  const [muted, setMuted] = useState(value.muted);
  const label = isDm ? channelName : `#${channelName}`;

  const save = () => {
    onSave({ level, muted });
    onNotify({ tone: "success", title: t("channel.notifUpdated"), description: label });
    onClose();
  };

  return (
    <Dialog
      title={isDm ? t("channel.dmNotifications") : t("channel.channelNotifications")}
      subtitle={label}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Radio name="notif" checked={level === "all"} onChange={() => setLevel("all")} label={t("channel.allMessages")} />
        <Radio name="notif" checked={level === "mentions"} onChange={() => setLevel("mentions")} label={t("channel.mentionsOnly")} description={t("channel.mentionsOnlyHint")} />
        <Radio name="notif" checked={level === "none"} onChange={() => setLevel("none")} label={t("channel.nothing")} />
        <div style={{ height: 1, background: "var(--border-subtle)", margin: "6px 0" }} />
        <Switch checked={muted} onChange={() => setMuted((m) => !m)} label={isDm ? t("channel.muteDm") : t("channel.muteChannel")} reverse />
      </div>
    </Dialog>
  );
}

/**
 * Add people to a channel.
 *
 * It used to list every member of the *space* with a checkbox, add nobody, and report success. Two
 * things were wrong at once: nothing was added, and unchecking someone already in the channel read
 * as removing them. Removing is a different act, with its own authorization, and is not offered
 * here; people already in the channel are shown as such, and cannot be unchecked.
 */
export function AddPeopleDialog({
  channelId,
  channelName,
  people,
  onClose,
  onNotify,
  onAdded,
}: {
  channelId: string;
  channelName: string;
  /** Everyone in the space: the pool to pick from. */
  people: { userId: string; name: string; presence: Presence; bot?: boolean; avatarUrl?: string }[];
  onClose: () => void;
  onNotify: (toast: Toast) => void;
  /** Called once people were actually added, so the caller can refresh what it shows. */
  onAdded?: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);

  // Who is already in. Until it arrives nobody is offered as addable, because adding someone who is
  // already there is the one outcome this dialog must not appear to produce.
  useEffect(() => {
    let active = true;
    listChannelMembers(channelId)
      .then((rows) => active && setCurrent(new Set(rows.map((m) => m.userId))))
      .catch(() => active && setError(key("channel.membersLoadFailed")));
    return () => {
      active = false;
    };
  }, [channelId]);

  const rows = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  const toggle = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const add = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const added = await addChannelMembers(channelId, [...selected]);
      onNotify({
        tone: "success",
        title:
          added.length === 0
            ? t("channel.nobodyToAdd")
            : t("channel.added", { count: added.length }),
        description: `#${channelName}`,
      });
      onAdded?.();
      onClose();
    } catch {
      setError(key("channel.addFailed"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("channel.addPeople")}
      closeLabel={t("common.close")}
      subtitle={`#${channelName}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" iconLeft="user-plus" disabled={busy || selected.size === 0} onClick={() => void add()}>
            {selected.size > 0 ? t("channel.addCount", { count: selected.size }) : t("channel.add")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input autoFocus icon="search" placeholder={t("channel.searchPerson")} value={q} onChange={(e) => setQ(e.target.value)} />
        {error ? (
          <p role="alert" style={{ fontSize: 12, color: "var(--text-danger, var(--terracotta-700))" }}>
            {t(error)}
          </p>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 260, overflow: "auto" }}>
          {rows.map((p) => {
            const inChannel = current?.has(p.userId) ?? false;
            return (
              <label
                key={p.userId}
                className={inChannel ? undefined : "wc-listrow"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: "var(--radius-md)",
                  cursor: inChannel ? "default" : "pointer",
                }}
              >
                {/* Already in: shown as a fact, not as a box someone could uncheck to remove them. */}
                <Checkbox
                  checked={inChannel || selected.has(p.userId)}
                  disabled={inChannel || current === null}
                  onChange={() => toggle(p.userId)}
                  aria-label={p.name}
                />
                <Avatar name={p.name} src={p.avatarUrl ?? getAvatar(p.name)} size={26} presence={p.presence} kind={p.bot ? "bot" : "person"} />
                <span style={{ flex: 1, fontSize: 13, color: inChannel ? "var(--text-muted)" : "var(--text-strong)" }}>
                  {p.name}
                </span>
                {inChannel ? <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>{t("channel.alreadyIn")}</span> : null}
              </label>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}

/** Confirm leaving a channel. */
export function LeaveChannelDialog({
  channelName,
  onClose,
  onConfirm,
}: {
  channelName: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("channel.leaveTitle", { name: channelName })}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="danger" iconLeft="arrow-left" onClick={onConfirm}>
            {t("sidebar.leaveChannel")}
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: "var(--text-body)" }}>
        {t("channel.leaveBody", { name: channelName })}
      </p>
    </Dialog>
  );
}
