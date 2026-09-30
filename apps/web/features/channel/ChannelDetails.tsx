"use client";

import type { CSSProperties, ReactNode } from "react";
import { Avatar, Icon, type IconName } from "@/components/ds";
import type { Channel } from "@/lib/data";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import { PanelHead } from "./PanelHead";
import type { ChannelMember } from "./SidePanel";

/**
 * A channel's details, as one page: what it is about, the three things done most (search it, set how
 * it notifies, bring people in), and the ways into everything else about it (its members, its pinned
 * messages, its files, its settings), with leaving it last and apart.
 *
 * This is what the channel's name opens on a phone, where the desktop header's row of icons does not
 * fit: one tap on the name, then everything is labelled rather than guessed from a pictogram.
 */
export type ChannelDetailsProps = {
  channel: Channel;
  members: ChannelMember[];
  canModerate: boolean;
  onClose: () => void;
  onOpenPanel: (panel: "members" | "pinned" | "files" | "search") => void;
  onNotifications: () => void;
  onAddPeople: () => void;
  onSettings: () => void;
  onLeave: () => void;
  onJoin: () => void;
};

const actionStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 72,
  padding: "10px 6px",
  border: "1.5px solid var(--border-default)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface-card)",
  font: "inherit",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  color: "var(--text-strong)",
  cursor: "pointer",
};

function Action({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="wc-lift" style={actionStyle} onClick={onClick}>
      <Icon name={icon} size={20} />
      {label}
    </button>
  );
}

function Row({ icon, label, detail, danger, onClick }: { icon: IconName; label: string; detail?: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`wc-sheet__item${danger ? " wc-sheet__item--danger" : ""}`} onClick={onClick}>
      <Icon name={icon} size={18} />
      <span className="wc-sheet__label">
        <span>{label}</span>
      </span>
      {detail}
      {danger ? null : <Icon name="chevron-right" size={16} />}
    </button>
  );
}

export function ChannelDetails({
  channel,
  members,
  canModerate,
  onClose,
  onOpenPanel,
  onNotifications,
  onAddPeople,
  onSettings,
  onLeave,
  onJoin,
}: ChannelDetailsProps) {
  const { t } = useTranslation();
  const member = channel.member !== false;
  const faces = members.slice(0, 4);
  return (
    <div style={{ width: "var(--panel-width)", flex: "none", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--surface-canvas)" }}>
      <PanelHead title={t("channel.details")} closeLabel={t("panel.close")} onClose={onClose} />
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px 32px" }}>
        <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-2xl)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.1, color: "var(--text-strong)", overflowWrap: "anywhere" }}>
          <Icon name={channel.type === "private" ? "lock" : "hash"} size={24} style={{ flex: "none", color: "var(--text-muted)" }} />
          {channel.name}
        </h2>
        {channel.topic ? <p style={{ margin: "8px 0 0", fontSize: "var(--text-md)", color: "var(--text-body)" }}>{channel.topic}</p> : null}

        <div style={{ display: "flex", gap: 10, margin: "20px 0" }}>
          <Action icon="search" label={t("common.search")} onClick={() => onOpenPanel("search")} />
          <Action icon="bell" label={t("notif.title")} onClick={onNotifications} />
          {canModerate ? <Action icon="user-plus" label={t("channel.addPeople")} onClick={onAddPeople} /> : null}
        </div>

        <div className="wc-sheet__group">
          <Row
            icon="users"
            label={t("conversation.members")}
            detail={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ display: "inline-flex" }}>
                  {faces.map((m, i) => (
                    <span key={m.id} style={{ marginLeft: i === 0 ? 0 : -8, display: "inline-flex", borderRadius: "var(--radius-sm)", boxShadow: "0 0 0 2px var(--surface-card)" }}>
                      <Avatar name={m.name} src={m.avatar ?? getAvatar(m.name)} size={24} kind={m.bot ? "bot" : "person"} />
                    </span>
                  ))}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{members.length}</span>
              </span>
            }
            onClick={() => onOpenPanel("members")}
          />
          <Row icon="pin" label={t("panel.pinned")} onClick={() => onOpenPanel("pinned")} />
          <Row icon="folder" label={t("gsearch.files")} onClick={() => onOpenPanel("files")} />
          <Row icon="settings" label={t("sidebar.channelSettings")} onClick={onSettings} />
        </div>

        <div className="wc-sheet__group">
          {member ? (
            <Row icon="arrow-left" label={t("sidebar.leaveChannel")} danger onClick={onLeave} />
          ) : (
            <Row icon="user-plus" label={t("sidebar.joinChannel")} onClick={onJoin} />
          )}
        </div>
      </div>
    </div>
  );
}
