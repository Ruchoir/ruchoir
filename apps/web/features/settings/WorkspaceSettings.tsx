"use client";

import { type CSSProperties, type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { Avatar, Button, Card, Field, Icon, type IconName, Input, Tag } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { Toast } from "../app/types";
import { clearSpaceIcon, renameSpace, setSpaceIcon } from "@/lib/data/api";
import { ImageCropDialog } from "../app/ImageCropDialog";
import { getAvatar } from "@/lib/data";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";

type NavKey = "general" | "members";

/** The sections, with the dictionary key of each label. */
const NAV: [NavKey, TranslationKey, IconName][] = [
  ["general", key("space.general"), "settings"],
  ["members", key("conversation.members"), "users"],
];

const st: Record<string, CSSProperties> = {
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 16px",
    margin: 0, // rendered as an <h1>
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  body: { flex: 1, overflow: "auto", display: "flex", minWidth: 0, minHeight: 0 },
  nav: { width: 200, flex: "none", padding: "16px 8px", borderRight: "1px solid var(--border-subtle)" },
  main: { flex: 1, minWidth: 0, padding: "24px 28px", maxWidth: 760 },
  h: { fontSize: 18, marginBottom: 4 },
  sub: { fontSize: 13, color: "var(--text-muted)", marginBottom: 20 },
  sect: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    margin: "24px 0 10px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
    rowGap: 8,
    padding: "12px 0",
    borderBottom: "1px solid var(--border-subtle)",
  },
  rowT: { fontSize: 13, fontWeight: 500, color: "var(--text-strong)" },
  rowD: { fontSize: 12, color: "var(--text-muted)", marginTop: 2, maxWidth: 420 },
};

function navItem(on: boolean, compact = false): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: compact ? "auto" : "100%",
    flex: "none",
    height: 30,
    padding: "0 10px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: on ? "var(--surface-selected)" : compact ? "var(--surface-sunken)" : "transparent",
    color: on ? "var(--text-accent)" : "var(--text-body)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: on ? 500 : 400,
    cursor: "pointer",
    textAlign: "left",
    whiteSpace: "nowrap",
  };
}

/** A title + description on the left, a control on the right, matching the mockup rows. */
function SettingRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div style={st.row}>
      <span>
        <div style={st.rowT}>{title}</div>
        {desc ? <div style={st.rowD}>{desc}</div> : null}
      </span>
      {children}
    </div>
  );
}

/** The space roles the API uses, as dictionary keys. */
const ROLE_LABEL: Record<string, TranslationKey> = {
  owner: key("role.owner"),
  admin: key("role.admin"),
  member: key("role.member"),
  guest: key("role.guest"),
};

export type WorkspaceSettingsProps = {
  workspaceName: string;
  /** The space being configured; needed to address its icon. */
  spaceId: string;
  /** Its current icon, when one was uploaded. */
  iconUrl?: string;
  /** Whether the caller may change the icon or the name. The API is the real guard; this hides a
   * dead control. */
  canAdminister: boolean;
  members: { name: string; presence: Presence; role: string; title?: string; bot: boolean }[];
  onInvite: () => void;
  /**
   * The icon changed. The rail reads the space list, not this screen's state, so without this the
   * new icon only appears after a reload.
   */
  onIconChanged: (url?: string) => void;
  /** The space was renamed. Same reason as `onIconChanged`: the rail reads the space list. */
  onRenamed: (name: string) => void;
  onNotify: (toast: Toast) => void;
  /**
   * Whether the caller owns the space, which is the only role allowed to delete it. The API is the
   * real guard; this keeps a control that would be refused off the screen.
   */
  canDelete: boolean;
  /** Open the deletion confirmation. The screen never deletes anything by itself. */
  onDelete: () => void;
  /**
   * Open the "leave this space" confirmation. Also offered from the space menu, which the compact
   * shell does not draw: without this entry, leaving a space would be a desktop-only act.
   */
  onLeave: () => void;
  /** Compact (mobile): stack the sub-nav above the panel and let setting rows wrap. */
  compact?: boolean;
};

/** The workspace settings view. Faithful to the design-system `screen-settings` mockup. */
export function WorkspaceSettings({
  workspaceName,
  spaceId,
  iconUrl,
  canAdminister,
  members,
  onInvite,
  onIconChanged,
  onRenamed,
  onNotify,
  canDelete,
  onDelete,
  onLeave,
  compact = false,
}: WorkspaceSettingsProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<NavKey>("general");
  // Read as what it is: a value owned by the browser. Empty for the static export's render, which
  // has no location, so nothing flashes a guessed address before the real one.
  const [memberQuery, setMemberQuery] = useState("");
  const shownMembers = members.filter((m) =>
    m.name.toLowerCase().includes(memberQuery.trim().toLowerCase()),
  );
  // Counted rather than asserted: the line used to read "2 invités externes, 1 bot" whatever the
  // space held.
  const memberSummary = (() => {
    const guests = members.filter((m) => m.role === "guest").length;
    const bots = members.filter((m) => m.bot).length;
    const people = members.length - bots;
    const parts = [t("space.members", { count: people })];
    if (guests > 0) parts.push(t("space.guests", { count: guests }));
    if (bots > 0) parts.push(t("space.bots", { count: bots }));
    return parts.join(", ");
  })();
  const serverAddress = useSyncExternalStore(
    () => () => {},
    () => window.location.host,
    () => "",
  );
  /** A local change since the space was loaded: a URL just uploaded, `null` just removed. */
  const [iconOverride, setIconOverride] = useState<string | null | undefined>(undefined);
  const [iconBusy, setIconBusy] = useState(false);
  /** The picked file, held until it has been cropped. */
  const [cropping, setCropping] = useState<File | null>(null);
  const icon = iconOverride === null ? undefined : (iconOverride ?? iconUrl);
  const iconRef = useRef<HTMLInputElement>(null);
  /** The name being edited. Seeded from the space and only sent when the button is pressed. */
  const [name, setName] = useState(workspaceName);
  const [nameBusy, setNameBusy] = useState(false);
  const nameDirty = name.trim() !== "" && name.trim() !== workspaceName;

  const onIconPicked = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (iconRef.current) iconRef.current.value = "";
    // Same reason as the avatar: the rail shows a square, so the square is chosen.
    setCropping(file);
  };

  const uploadCropped = async (file: File) => {
    setCropping(null);
    setIconBusy(true);
    try {
      const url = await setSpaceIcon(spaceId, file);
      setIconOverride(url);
      onIconChanged(url);
      onNotify({ tone: "success", title: t("space.iconUpdated"), description: workspaceName });
    } catch {
      onNotify({ tone: "danger", title: t("space.iconFailed"), description: t("profile.photoFailedHint") });
    } finally {
      setIconBusy(false);
    }
  };

  const saveName = async () => {
    setNameBusy(true);
    try {
      const space = await renameSpace(spaceId, name.trim());
      onRenamed(space.name);
      onNotify({ tone: "success", title: t("space.renamed"), description: space.name });
    } catch {
      onNotify({ tone: "danger", title: t("space.nameFailed"), description: t("space.retry") });
    } finally {
      setNameBusy(false);
    }
  };

  const removeIcon = async () => {
    setIconBusy(true);
    try {
      await clearSpaceIcon(spaceId);
      setIconOverride(null);
      onIconChanged(undefined);
    } catch {
      onNotify({ tone: "danger", title: t("space.iconNotRemoved") });
    } finally {
      setIconBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      <h1 style={st.top}>
        <Icon name="settings" size={15} style={{ color: "var(--text-muted)" }} />
        {t("sidebar.spaceSettings")}
      </h1>
      <div style={compact ? { ...st.body, flexDirection: "column" } : st.body}>
        <div
          style={
            compact
              ? {
                  flex: "none",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border-subtle)",
                }
              : st.nav
          }
        >
          {NAV.map(([v, l, i]) => (
            <button key={v} style={navItem(v === tab, compact)} onClick={() => setTab(v)}>
              <Icon name={i} size={14} style={{ color: "var(--text-muted)" }} />
              {t(l)}
            </button>
          ))}
        </div>
        <div style={compact ? { ...st.main, padding: "16px 16px 24px" } : st.main}>
          {tab === "general" ? (
            <>
              <h2 style={st.h}>{t("space.general")}</h2>
              <p style={st.sub}>{t("space.generalSub", { name: workspaceName })}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 420 }}>
                <Field label={t("space.icon")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={workspaceName} src={icon} kind="workspace" size={48} />
                    {canAdminister ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          iconLeft="image"
                          disabled={iconBusy}
                          onClick={() => iconRef.current?.click()}
                        >
                          {iconBusy ? t("common.sending") : t("space.changeIcon")}
                        </Button>
                        {icon ? (
                          <Button size="sm" variant="link" disabled={iconBusy} onClick={() => void removeIcon()}>
                            {t("common.remove")}
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                        {t("space.adminsOnlyIcon")}
                      </span>
                    )}
                    <input
                      ref={iconRef}
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={(e) => onIconPicked(e.target.files)}
                    />
                  </div>
                </Field>
                <Field
                  label={t("space.name")}
                  hint={
                    canAdminister
                      ? t("space.addressFollowsName")
                      : t("space.adminsOnlyRename")
                  }
                  htmlFor="wn"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input
                      id="wn"
                      value={name}
                      disabled={!canAdminister || nameBusy}
                      onChange={(e) => setName(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    {canAdminister ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!nameDirty || nameBusy}
                        onClick={() => void saveName()}
                      >
                        {nameBusy ? t("common.sending") : t("common.save")}
                      </Button>
                    ) : null}
                  </div>
                </Field>
                <Field label={t("space.serverAddress")} hint={t("space.setAtInstall")} htmlFor="wu">
                  {/* Read from the page rather than stored: this client is served by the instance it
                      is describing, so its own address is the answer. It used to show a name that
                      was invented, and therefore wrong everywhere. */}
                  <Input id="wu" value={serverAddress} readOnly disabled />
                </Field>
              </div>
              {/* The two exits. Leaving is also in the space menu, which the compact shell does not
                  draw, so this is where it is reachable on a phone. Deleting is only here: the menu
                  is where one person walks out, this is where the space itself is administered. A
                  button was shown here once with nothing behind it, announcing an erasure in 30 days
                  that never came; these two call the endpoints, and what they say is what happens. */}
              <div style={st.sect}>{t("space.danger")}</div>
              <SettingRow title={t("space.leave")} desc={t("space.leaveDesc")}>
                <Button size="sm" variant="secondary" iconLeft="log-out" onClick={onLeave}>
                  {t("space.leave")}
                </Button>
              </SettingRow>
              {canDelete ? (
                <SettingRow title={t("space.delete")} desc={t("space.deleteDesc")}>
                  <Button size="sm" variant="danger" iconLeft="trash-2" onClick={onDelete}>
                    {t("space.delete")}
                  </Button>
                </SettingRow>
              ) : null}
            </>
          ) : null}

          {tab === "members" ? (
            <>
              <h2 style={st.h}>{t("conversation.members")}</h2>
              <p style={st.sub}>{memberSummary}</p>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <div style={{ width: 260 }}>
                  <Input
                    size="sm"
                    icon="search"
                    placeholder={t("space.searchMember")}
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }} />
                <Button size="sm" variant="primary" iconLeft="user-plus" onClick={onInvite}>
                  {t("space.invite")}
                </Button>
              </div>
              <Card>
                {shownMembers.map((m, i) => {
                  const role = ROLE_LABEL[m.role] ?? key("role.member");
                  const guest = m.role === "guest";
                  return (
                    <div
                      key={m.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 14px",
                        borderTop: i ? "1px solid var(--border-subtle)" : "none",
                      }}
                    >
                      <Avatar name={m.name} src={getAvatar(m.name)} size={28} presence={m.presence} shape={guest ? "round" : "square"} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{m.name}</div>
                        {/* Their job title when they have set one. The address used to be shown here,
                            invented from the first name and a domain nobody owns. */}
                        {m.title ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{m.title}</div> : null}
                      </span>
                      {m.bot ? <Tag>{t("sidebar.bot")}</Tag> : null}
                      {guest ? <Tag tone="warning">{t("space.external")}</Tag> : null}
                      {/* Read, not set: changing someone's role needs rules that do not exist yet, and
                          a select that reported success without moving anything is worse than none. */}
                      <span style={{ fontSize: 12, color: "var(--text-muted)", width: 130, textAlign: "right" }}>
                        {t(role)}
                      </span>
                    </div>
                  );
                })}
              </Card>
            </>
          ) : null}

        </div>
      </div>


      {cropping ? (
        <ImageCropDialog
          file={cropping}
          title={t("space.cropIcon")}
          onCancel={() => setCropping(null)}
          onConfirm={(cropped) => void uploadCropped(cropped)}
        />
      ) : null}
    </div>
  );
}
