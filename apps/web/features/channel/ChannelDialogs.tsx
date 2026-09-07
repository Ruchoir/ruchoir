"use client";

import { useState } from "react";
import { Avatar, Button, Checkbox, Dialog, Field, Input, Radio, Select, Switch } from "@/components/ds";
import type { Presence } from "@/components/ds";
import { getAvatar, getChannelMembers } from "@/lib/data";
import type { Channel, ChannelType } from "@/lib/data";
import type { ChannelNotifPref, NotifLevel } from "../app/notifications";
import type { Toast } from "../app/types";

const CHANNEL_ROLES = ["Membre", "Modérateur", "Administrateur"];

/** Edit a channel's name, topic, visibility and (for private channels) member access and roles. */
export function ChannelSettingsDialog({
  channel,
  onClose,
  onUpdate,
  onNotify,
}: {
  channel: Channel;
  onClose: () => void;
  onUpdate: (patch: Partial<Channel>) => void;
  onNotify: (toast: Toast) => void;
}) {
  const members = getChannelMembers();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [type, setType] = useState<ChannelType>(channel.type === "archived" ? "public" : channel.type);
  const [archived, setArchived] = useState(channel.type === "archived");
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
    onUpdate({ name: clean || channel.name, topic: topic.trim(), type: archived ? "archived" : type });
    onNotify({ tone: "success", title: "Canal mis à jour", description: `#${clean || channel.name}` });
    onClose();
  };

  return (
    <Dialog
      title="Paramètres du canal"
      size={isPrivate ? "md" : "sm"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={save}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label="Nom du canal" htmlFor="cs-name">
          <Input id="cs-name" icon="hash" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Sujet" optional htmlFor="cs-topic">
          <Input id="cs-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="À quoi sert ce canal ?" />
        </Field>
        <Field label="Visibilité">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Radio name="cs-type" checked={type === "public"} disabled={archived} onChange={() => setType("public")} label="Public" description="Tous les membres de l'espace peuvent le rejoindre." />
            <Radio name="cs-type" checked={type === "private"} disabled={archived} onChange={() => setType("private")} label="Privé" description="Seules les personnes ci-dessous y ont accès." />
          </div>
        </Field>

        {isPrivate ? (
          <Field label={`Membres et accès (${access.size})`}>
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
                    <Checkbox checked={has} onChange={() => toggleAccess(m.name)} aria-label={`Accès de ${m.name}`} />
                    <Avatar name={m.name} src={m.avatar} size={26} presence={m.presence} kind={m.bot ? "bot" : "person"} />
                    <span style={{ flex: 1, fontSize: 13, color: has ? "var(--text-strong)" : "var(--text-muted)" }}>{m.name}</span>
                    <div style={{ width: 150 }}>
                      <Select size="sm" options={CHANNEL_ROLES} disabled={!has} defaultValue="Membre" aria-label={`Rôle de ${m.name}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Field>
        ) : null}

        <Switch checked={archived} onChange={() => setArchived((a) => !a)} label="Archiver le canal (lecture seule)" reverse />
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
  const [level, setLevel] = useState<NotifLevel>(value.level);
  const [muted, setMuted] = useState(value.muted);
  const label = isDm ? channelName : `#${channelName}`;

  const save = () => {
    onSave({ level, muted });
    onNotify({ tone: "success", title: "Notifications mises à jour", description: label });
    onClose();
  };

  return (
    <Dialog
      title={isDm ? "Notifications de la conversation" : "Notifications du canal"}
      subtitle={label}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={save}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Radio name="notif" checked={level === "all"} onChange={() => setLevel("all")} label="Tous les messages" />
        <Radio name="notif" checked={level === "mentions"} onChange={() => setLevel("mentions")} label="Mentions uniquement" description="@vous et @canal" />
        <Radio name="notif" checked={level === "none"} onChange={() => setLevel("none")} label="Rien" />
        <div style={{ height: 1, background: "var(--border-subtle)", margin: "6px 0" }} />
        <Switch checked={muted} onChange={() => setMuted((m) => !m)} label={isDm ? "Mettre la conversation en sourdine" : "Mettre le canal en sourdine"} reverse />
      </div>
    </Dialog>
  );
}

/** Add people to a channel. */
export function AddPeopleDialog({
  channelName,
  people,
  onClose,
  onNotify,
}: {
  channelName: string;
  people: { name: string; presence: Presence; bot?: boolean }[];
  onClose: () => void;
  onNotify: (toast: Toast) => void;
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rows = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const add = () => {
    if (selected.size === 0) return;
    onNotify({
      tone: "success",
      title: `${selected.size} personne${selected.size > 1 ? "s" : ""} ajoutée${selected.size > 1 ? "s" : ""}`,
      description: `#${channelName}`,
    });
    onClose();
  };

  return (
    <Dialog
      title="Ajouter des personnes"
      subtitle={`#${channelName}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" iconLeft="user-plus" onClick={add}>
            Ajouter{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input autoFocus icon="search" placeholder="Rechercher une personne" value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 260, overflow: "auto" }}>
          {rows.map((p) => (
            <label
              key={p.name}
              className="wc-listrow"
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: "var(--radius-md)", cursor: "pointer" }}
            >
              <Checkbox checked={selected.has(p.name)} onChange={() => toggle(p.name)} aria-label={p.name} />
              <Avatar name={p.name} src={getAvatar(p.name)} size={26} presence={p.presence} kind={p.bot ? "bot" : "person"} />
              <span style={{ fontSize: 13, color: "var(--text-strong)" }}>{p.name}</span>
            </label>
          ))}
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
  return (
    <Dialog
      title={`Quitter #${channelName} ?`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="danger" iconLeft="arrow-left" onClick={onConfirm}>
            Quitter le canal
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: "var(--text-body)" }}>
        Vous ne recevrez plus les messages de #{channelName}. Vous pourrez le rejoindre à nouveau tant qu&apos;il est public.
      </p>
    </Dialog>
  );
}
