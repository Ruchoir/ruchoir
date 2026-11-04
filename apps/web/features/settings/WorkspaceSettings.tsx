"use client";

import { type CSSProperties, type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { Avatar, Button, Field, Icon, type IconName, Input, Select } from "@/components/ds";
import type { Toast } from "../app/types";
import { clearSpaceIcon, renameSpace, setDefaultChannel, setSpaceIcon } from "@/lib/data/api";
import type { Channel } from "@/lib/data";
import type { Group, Role, SpaceEdition, SpaceLicence } from "@/lib/data/types";
import { ImageCropDialog } from "../app/ImageCropDialog";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { formatUtcDate } from "@/lib/i18n/format";
import { BackHeading } from "../app/BackHeading";
import { MembersSettings, type SettingsMember } from "./MembersSettings";
import { RolesSettings } from "./RolesSettings";
import { GroupsSettings } from "./GroupsSettings";
import { AuditSettings } from "./AuditSettings";
import { LicenceSettings } from "./LicenceSettings";

type NavKey = "general" | "members" | "roles" | "groups" | "audit" | "licence";

/**
 * The sections, with the dictionary key of each label. The member list and the roles are
 * administration (who is here, what each may do, who gets shown the door), so they are not drawn
 * for someone the API would refuse; everyone keeps the general section, which is also where leaving
 * the space lives.
 */
const NAV: [NavKey, TranslationKey, IconName][] = [
  ["general", key("space.general"), "settings"],
  ["members", key("conversation.members"), "users"],
  ["roles", key("roles.title"), "shield"],
  ["groups", key("groups.title"), "users"],
  ["audit", key("audit.title"), "list"],
  ["licence", key("licence.title"), "key-round"],
];

const st: Record<string, CSSProperties> = {
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 20px",
    margin: 0, // rendered as an <h1>
    borderBottom: "1.5px solid var(--border-subtle)",
    fontSize: "var(--text-lg)",
    fontWeight: 700,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  body: { flex: 1, overflow: "auto", display: "flex", minWidth: 0, minHeight: 0 },
  nav: {
    width: 220,
    flex: "none",
    padding: "16px 8px",
    background: "var(--surface-chrome)",
    borderRight: "1.5px solid var(--border-subtle)",
  },
  main: { flex: 1, minWidth: 0, padding: "40px 40px 64px", maxWidth: 820 },
  // The same heading as the preferences: the two are the product's two settings screens.
  h: {
    fontSize: "clamp(28px, 3.4vw, 40px)",
    fontWeight: 700,
    letterSpacing: "var(--tracking-display)",
    lineHeight: 1.05,
    color: "var(--text-strong)",
    marginBottom: 10,
  },
  sub: { fontSize: "var(--text-md)", color: "var(--text-body)", marginBottom: 20 },
  sect: {
    fontFamily: "var(--label-font)",
    fontSize: "var(--text-2xs)",
    fontWeight: 500,
    color: "var(--text-muted)",
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
  rowT: { fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" },
  rowD: { fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 2, maxWidth: 420 },
  banner: {
    flex: "none",
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "10px 20px",
    background: "var(--sky)",
    color: "var(--on-pastel)",
    borderBottom: "1.5px solid var(--on-pastel)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-snug)",
  },
};

function navItem(on: boolean, compact = false): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: compact ? "auto" : "100%",
    flex: "none",
    height: compact ? 32 : 36,
    padding: "0 10px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: on ? "var(--acc)" : compact ? "var(--surface-sunken)" : "transparent",
    color: on ? "var(--on-pastel)" : "var(--text-body)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: on ? 600 : 400,
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

export type WorkspaceSettingsProps = {
  workspaceName: string;
  /** The space being configured; needed to address its icon. */
  spaceId: string;
  /** Its current icon, when one was uploaded. */
  iconUrl?: string;
  /**
   * Whether the caller may change the space's identity: its name and its icon. The owner alone, who
   * holds the space; an administrator runs it. The API is the real guard; this hides a dead control.
   */
  canEditIdentity: boolean;
  /**
   * Whether the caller administers people here (`members.manage` or `roles.manage`). Gates the
   * member list and the roles, which the API refuses to anyone else.
   */
  canManageMembers: boolean;
  /** Whether the caller may invite (`members.invite`). */
  canInvite: boolean;
  /** Whether the caller sets the arrival channel (`space.settings`). */
  canSetDefaultChannel: boolean;
  /** The edition the space runs, which decides how roles are given. */
  edition: SpaceEdition;
  /** When the space's licence expired, for the frozen banner; and its owners' names. */
  frozenSince?: string;
  ownerNames: string[];
  /** The space's roles, strongest first (empty from an instance without them). */
  roles: Role[];
  /** The space's groups (empty when the caller cannot list them, a guest for one). */
  groups: Group[];
  /** What the caller holds in the space, by permission name. */
  myRights: string[];
  /** The caller's id, to find their own membership. */
  myUserId?: string;
  /** Where the publisher's prices are, for the community roles' one line about more. */
  pricingUrl?: string;
  /** The roles or someone's roles changed: read them again. */
  onAccessChanged: () => Promise<void>;
  /** Set one person's roles, strongest first; resolves to whether it was saved. */
  onSaveMemberRoles: (userId: string, roleIds: string[]) => Promise<boolean>;
  /** Whether the caller reads the space's audit log (`audit.view`). */
  canReadAudit: boolean;
  /** Whether the caller manages the space's groups (`groups.manage`). */
  canManageGroups: boolean;
  /** Whether the caller manages the space's licence: its owner, on an instance that has licences. */
  canManageLicence: boolean;
  /** The space's licence as its list says (owners only), for the days left. */
  licence?: SpaceLicence;
  /** A licence was installed or removed: read the space again. */
  onLicenceChanged: () => Promise<void>;
  /** Channels in this space, used to select the arrival channel. */
  channels: Channel[];
  defaultChannelId?: string;
  /** The space's members as the API lists them, with their live presence. */
  members: SettingsMember[];
  /** The caller's own role in this space, which decides which roles they may hand out. */
  myRole: string;
  /**
   * Change a member's role. Carries the member rather than the id alone, because handing the space
   * over is confirmed by name and the caller should not have to look it up again.
   */
  onChangeRole: (member: { userId: string; name: string }, role: string) => void;
  /** Ask to take a member out of the space. Confirmed elsewhere; this only opens the question. */
  onRemoveMember: (member: { userId: string; name: string }) => void;
  onInvite: () => void;
  /**
   * The icon changed. The rail reads the space list, not this screen's state, so without this the
   * new icon only appears after a reload.
   */
  onIconChanged: (url?: string) => void;
  /** The space was renamed. Same reason as `onIconChanged`: the rail reads the space list. */
  onRenamed: (name: string) => void;
  /** Keep the rail and sidebar aligned with a changed arrival channel. */
  onDefaultChannelChanged: (channelId: string) => void;
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
  /** A phone: the way back to the tabs, at the start of the heading. */
  onBack?: () => void;
  compact?: boolean;
};

/** The workspace settings view. Faithful to the design-system `screen-settings` mockup. */
export function WorkspaceSettings({
  workspaceName,
  spaceId,
  iconUrl,
  canEditIdentity,
  canManageMembers,
  canInvite,
  canSetDefaultChannel,
  edition,
  frozenSince,
  ownerNames,
  roles,
  groups,
  myRights,
  myUserId,
  pricingUrl,
  onAccessChanged,
  onSaveMemberRoles,
  canReadAudit,
  canManageGroups,
  canManageLicence,
  licence,
  onLicenceChanged,
  channels,
  defaultChannelId,
  members,
  myRole,
  onChangeRole,
  onRemoveMember,
  onInvite,
  onIconChanged,
  onRenamed,
  onDefaultChannelChanged,
  onNotify,
  canDelete,
  onDelete,
  onLeave,
  onBack,
  compact = false,
}: WorkspaceSettingsProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<NavKey>("general");
  // A group opened from elsewhere (a role's people): the Groupes tab shows it straight away.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const sections = NAV.filter(([id]) =>
    id === "audit" ? canReadAudit : id === "groups" ? canManageGroups : id === "licence" ? canManageLicence : id === "general" || canManageMembers,
  );
  const me = members.find((m) => m.userId === myUserId);
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
  const [defaultChannelBusy, setDefaultChannelBusy] = useState(false);
  const nameDirty = name.trim() !== "" && name.trim() !== workspaceName;
  const defaultChannelOptions = channels
    .filter((channel) => channel.type === "public" && !channel.allowedRoles?.length)
    .map((channel) => ({ value: channel.id, label: `#${channel.name}` }));

  const changeDefaultChannel = async (channelId: string) => {
    setDefaultChannelBusy(true);
    try {
      const space = await setDefaultChannel(spaceId, channelId);
      onDefaultChannelChanged(space.defaultChannelId ?? channelId);
      onNotify({ tone: "success", title: t("space.defaultChannelUpdated") });
    } catch {
      onNotify({ tone: "danger", title: t("space.defaultChannelFailed"), description: t("space.retry") });
    } finally {
      setDefaultChannelBusy(false);
    }
  };

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
      <BackHeading onBack={onBack} bar={st.top}>
        <h1 style={onBack ? { ...st.top, height: "auto", padding: 0, border: 0, flex: 1, minWidth: 0 } : st.top}>
          <Icon name="settings" size={15} style={{ color: "var(--text-muted)" }} />
          {t("sidebar.spaceSettings")}
        </h1>
      </BackHeading>
      {edition === "frozen" ? (
        <div role="status" style={st.banner}>
          <Icon name="clock" size={15} style={{ flex: "none", marginTop: 1 }} />
          <span>
            <b>{frozenSince ? t("roles.frozenBannerSince", { date: formatUtcDate(frozenSince) }) : t("roles.frozenBanner")}</b>{" "}
            {t("roles.frozenBannerRest", { owners: ownerNames.join(", "), count: ownerNames.length })}
          </span>
        </div>
      ) : null}
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
          {sections.map(([v, l, i]) => (
            <button key={v} style={navItem(v === tab, compact)} onClick={() => {
                setOpenGroup(null);
                setTab(v);
              }}>
              <Icon name={i} size={14} style={{ color: v === tab ? "var(--on-pastel)" : "var(--text-muted)" }} />
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
                    {canEditIdentity ? (
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
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                        {t("space.ownerOnlyIcon")}
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
                    canEditIdentity
                      ? t("space.addressFollowsName")
                      : t("space.ownerOnlyRename")
                  }
                  htmlFor="wn"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input
                      id="wn"
                      value={name}
                      disabled={!canEditIdentity || nameBusy}
                      onChange={(e) => setName(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    {canEditIdentity ? (
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
                {canSetDefaultChannel && defaultChannelId ? (
                  <SettingRow title={t("space.defaultChannel")} desc={t("space.defaultChannelDesc")}>
                    <div style={{ width: 220 }}>
                      <Select
                        aria-label={t("space.defaultChannel")}
                        value={defaultChannelId}
                        disabled={defaultChannelBusy}
                        onChange={(event) => void changeDefaultChannel(event.target.value)}
                        options={defaultChannelOptions}
                      />
                    </div>
                  </SettingRow>
                ) : null}
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

          {tab === "members" && canManageMembers ? (
            <MembersSettings
              spaceName={workspaceName}
              edition={edition}
              members={members}
              me={me}
              myRole={myRole}
              myRights={myRights}
              roles={roles}
              groups={groups}
              spaceId={spaceId}
              onGroupsChanged={onAccessChanged}
              onNotify={onNotify}
              canInvite={canInvite}
              summary={memberSummary}
              onInvite={onInvite}
              onChangeRole={onChangeRole}
              onRemoveMember={onRemoveMember}
              onSaveMemberRoles={onSaveMemberRoles}
              compact={compact}
            />
          ) : null}

          {tab === "roles" && canManageMembers ? (
            <RolesSettings
              spaceId={spaceId}
              spaceName={workspaceName}
              edition={edition}
              roles={roles}
              groups={groups}
              members={members}
              me={me}
              myRights={myRights}
              pricingUrl={pricingUrl}
              onChanged={onAccessChanged}
              onOpenGroup={
                canManageGroups
                  ? (id) => {
                      setOpenGroup(id);
                      setTab("groups");
                    }
                  : undefined
              }
              onSetMemberRoles={onSaveMemberRoles}
              onNotify={onNotify}
            />
          ) : null}

          {tab === "groups" && canManageGroups ? (
            <GroupsSettings
              spaceId={spaceId}
              initialGroupId={openGroup}
              spaceName={workspaceName}
              edition={edition}
              roles={roles}
              members={members}
              groups={groups}
              me={me}
              pricingUrl={pricingUrl}
              onChanged={onAccessChanged}
              onNotify={onNotify}
            />
          ) : null}

          {tab === "audit" && canReadAudit ? <AuditSettings spaceId={spaceId} members={members} roles={roles} /> : null}

          {tab === "licence" && canManageLicence ? (
            <LicenceSettings
              spaceId={spaceId}
              spaceName={workspaceName}
              edition={edition}
              licence={licence}
              pricingUrl={pricingUrl}
              onChanged={onLicenceChanged}
              onNotify={onNotify}
            />
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
