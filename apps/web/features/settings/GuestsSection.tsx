"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Avatar, Button, Card, Icon, IconButton, Tag } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { MenuPopover } from "../app/MenuPopover";
import type { Toast } from "../app/types";
import { browserZone, canSeeEnded, endLabel, guestMenu, guestRow, inDaysLabel } from "./guestLogic.ts";
import { PasserMembreDialog } from "./StandingDialogs";
import { ProlongDialog } from "./ProlongDialog";
import type { SettingsMember } from "./MembersSettings";
import { grantableRoles } from "./rolesLogic";

const st: Record<string, CSSProperties> = {
  head: { display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap", margin: "28px 0 10px" },
  title: { display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text-strong)" },
  count: { fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", background: "var(--surface-sunken)", borderRadius: 999, padding: "1px 8px" },
  note: { margin: "4px 0 0", fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-snug)", maxWidth: 560 },
  row: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" },
  name: { fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" },
  sub: { fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  until: { width: 220, flex: "none", display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" },
  act: { flex: "none", display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" },
};

/**
 * The guests of the space, apart from its members: who, until when, and the way to move that date.
 * A guest whose end is near carries the warning and a Prolong button; the rest is in the menu.
 * Only the guests' rights button is optional (it lives with the guest rights screen).
 */
export function GuestsSection({
  guests,
  spaceId,
  myRole,
  myRights,
  licensed,
  compact,
  onSaved,
  onNotify,
  onManage,
  onChangeRole,
  onRemoveMember,
  onGuestRights,
  initialProlong,
}: {
  guests: SettingsMember[];
  spaceId: string;
  myRole: string;
  myRights: string[];
  /** A licensed space: the row menu offers "Passer membre" (a dialog); a community one changes it from Gestion. */
  licensed: boolean;
  compact?: boolean;
  /** An end date changed: read the people again. */
  onSaved: () => Promise<void>;
  onNotify: (toast: Toast) => void;
  onManage: (userId: string) => void;
  onChangeRole: (member: { userId: string; name: string }, role: string) => void;
  onRemoveMember: (member: { userId: string; name: string }) => void;
  onGuestRights?: () => void;
  /** A guest whose prolong dialog is open from the start. */
  initialProlong?: string;
}) {
  const { t } = useTranslation();
  const [prolonging, setProlonging] = useState<string | null>(initialProlong ?? null);
  const [now] = useState(() => new Date());
  const canDate = canSeeEnded(myRights);
  const [promoting, setPromoting] = useState<string | null>(null);
  const promoted = promoting ? guests.find((g) => g.userId === promoting) : undefined;
  const target = prolonging ? guests.find((g) => g.userId === prolonging) : undefined;

  return (
    <section aria-labelledby="guests-title">
      <div style={st.head}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h3 id="guests-title" style={st.title}>
            {t("guests.sectionTitle")}
            <span style={st.count}>{guests.length}</span>
          </h3>
          <p style={st.note}>{t("guests.sectionNote")}</p>
        </div>
        {onGuestRights ? (
          <Button size="sm" variant="secondary" iconLeft="shield-check" onClick={onGuestRights}>
            {t("guests.rights")}
          </Button>
        ) : null}
      </div>
      <Card>
        {!compact ? (
          <div style={{ ...st.row, padding: "8px 14px", fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", borderBottom: "1px solid var(--border-subtle)" }}>
            <span style={{ flex: 1 }}>{t("guests.guestTag")}</span>
            <span style={st.until}>{t("guests.endTitle")}</span>
            <span style={{ ...st.act, width: 128 }} />
          </div>
        ) : null}
        {guests.map((g, i) => (
          <GuestRow
            key={g.userId}
            guest={g}
            first={i === 0}
            now={now}
            compact={compact}
            canDate={canDate && (g.manageable === true || grantableRoles(myRole, g.role).length > 0)}
            canAct={g.manageable === true || grantableRoles(myRole, g.role).length > 0}
            licensed={licensed}
            onPromote={() => setPromoting(g.userId)}
            onProlong={() => setProlonging(g.userId)}
            onManage={() => onManage(g.userId)}
            onRemoveMember={onRemoveMember}
          />
        ))}
      </Card>
      {promoted ? (
        <PasserMembreDialog member={promoted} spaceId={spaceId} onClose={() => setPromoting(null)} onChanged={onSaved} />
      ) : null}
      {target ? (
        <ProlongDialog
          guest={{ userId: target.userId, name: target.name, title: target.title, expiresAt: target.expiresAt }}
          spaceId={spaceId}
          onClose={() => setProlonging(null)}
          onSaved={onSaved}
          onNotify={onNotify}
        />
      ) : null}
    </section>
  );
}

function GuestRow({
  guest,
  first,
  now,
  compact,
  canDate,
  canAct,
  licensed,
  onPromote,
  onProlong,
  onManage,
  onRemoveMember,
}: {
  guest: SettingsMember;
  first: boolean;
  now: Date;
  compact?: boolean;
  canDate: boolean;
  canAct: boolean;
  licensed: boolean;
  onPromote: () => void;
  onProlong: () => void;
  onManage: () => void;
  onRemoveMember: (member: { userId: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const zone = browserZone();
  const row = guestRow(guest, now);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const person = { userId: guest.userId, name: guest.name };
  const run: Record<string, () => void> = { manage: onManage, changeDate: onProlong, setDate: onProlong, passerMembre: onPromote, remove: () => onRemoveMember(person) };
  const items = guestMenu({ licensed, canDate, hasEnd: !!row.end, canAct }).map((it) => ({
    icon: it.id === "manage" ? "settings" : it.id === "remove" ? "user-minus" : it.id === "passerMembre" ? "user-plus" : "calendar-clock",
    label: it.id === "manage" ? t("profile.tabManage") : it.id === "changeDate" ? t("guests.changeDate") : it.id === "setDate" ? t("guests.setDate") : it.id === "passerMembre" ? t("guests.passerMembreAction") : t("common.remove"),
    danger: it.id === "remove",
    onClick: () => {
      setMenu(false);
      run[it.id]();
    },
  }));
  return (
    <div style={{ ...st.row, flexWrap: compact ? "wrap" : "nowrap", borderTop: first ? "none" : "1px solid var(--border-subtle)" }}>
      <Avatar name={guest.name} src={guest.avatarUrl ?? getAvatar(guest.name)} size={28} presence={guest.presence} shape="round" />
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ minWidth: 0 }}>
          <div style={st.name}>{guest.name}</div>
          {guest.title ? <div style={st.sub}>{guest.title}</div> : null}
        </span>
        <Tag tone="warning">{t("guests.guestTag")}</Tag>
      </span>
      <span style={compact ? { ...st.until, width: "100%", order: 3, paddingLeft: 40 } : st.until}>
        {row.end && row.days !== null ? (
          <>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-strong)" }}>{endLabel(row.end, locale, zone)}</span>
            {row.warn ? (
              <Tag tone="warning" icon="alert-triangle">
                {inDaysLabel(row.days, locale)}
              </Tag>
            ) : (
              <span style={st.sub}>{inDaysLabel(row.days, locale)}</span>
            )}
          </>
        ) : (
          <span style={st.sub}>{t("guests.noEnd")}</span>
        )}
      </span>
      <span style={{ ...st.act, width: compact ? undefined : 128 }}>
        {canDate && row.prolong ? (
          <Button size="sm" variant="secondary" iconLeft="calendar-plus" onClick={onProlong}>
            {t("guests.prolong")}
          </Button>
        ) : null}
        {canAct ? (
          <>
            <IconButton ref={menuRef} icon="more-horizontal" size="sm" label={t("sidebar.actionsFor", { name: guest.name })} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((o) => !o)} />
            <MenuPopover anchorRef={menuRef} open={menu} onClose={() => setMenu(false)} items={items} align="end" label={t("sidebar.actionsFor", { name: guest.name })} />
          </>
        ) : (
          <Icon name="lock" size={13} style={{ color: "var(--text-muted)" }} />
        )}
      </span>
    </div>
  );
}
