"use client";

import { type CSSProperties, Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { Avatar, Button, Card, Select, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { getAudit } from "@/lib/data/api";
import type { AuditEntry, Role } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { formatDate, formatDayHeading, formatTime } from "@/lib/i18n/format";
import { auditLine, dayKey, type Sentence, type Slot } from "./auditLogic";
import { RoleDot, ROLE_LABEL } from "./MemberAccess";
import { PERMISSION_TEXT } from "./permissionText";

/** Each sentence's words, with `{{actor}}` and the other slots and values to fill. */
const SENTENCE: Record<Sentence, TranslationKey> = {
  memberJoined: key("audit.memberJoined"),
  memberJoinedGuest: key("audit.memberJoinedGuest"),
  memberLeft: key("audit.memberLeft"),
  memberRemoved: key("audit.memberRemoved"),
  memberRoleChanged: key("audit.memberRoleChanged"),
  ownershipTransferred: key("audit.ownershipTransferred"),
  memberRolesChanged: key("audit.memberRolesChanged"),
  roleCreated: key("audit.roleCreated"),
  roleUpdated: key("audit.roleUpdated"),
  roleRenamed: key("audit.roleRenamed"),
  roleDeleted: key("audit.roleDeleted"),
  rolesReordered: key("audit.rolesReordered"),
  channelReserved: key("audit.channelReserved"),
  channelOpened: key("audit.channelOpened"),
  calendarWriteMembers: key("audit.calendarWriteMembers"),
  calendarWriteAdmins: key("audit.calendarWriteAdmins"),
  licenceInstalled: key("audit.licenceInstalled"),
  licenceRemoved: key("audit.licenceRemoved"),
  unknown: key("audit.unknown"),
};

/** The families, as the filter and each line's tag name them. */
const CATEGORY: Record<string, TranslationKey> = {
  members: key("conversation.members"),
  roles: key("roles.title"),
  channels: key("tabs.channels"),
  calendars: key("calendar.calendars"),
  licence: key("licence.title"),
};

const PERIOD_DAYS: Record<string, number | undefined> = { "7": 7, "30": 30, "90": 90, all: undefined };

const st: Record<string, CSSProperties> = {
  h: { fontSize: "clamp(28px, 3.4vw, 40px)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.05, color: "var(--text-strong)", marginBottom: 10 },
  sub: { fontSize: "var(--text-md)", color: "var(--text-body)", marginBottom: 20 },
  day: { fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", margin: "20px 0 8px" },
  row: { display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 14px" },
  time: { width: 44, flex: "none", fontSize: "var(--text-2xs)", color: "var(--text-muted)", paddingTop: 4, fontVariantNumeric: "tabular-nums" },
  text: { flex: 1, minWidth: 0, fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-snug)", paddingTop: 3 },
  chip: { display: "inline-flex", alignItems: "center", gap: 5, padding: "0 7px", borderRadius: "var(--radius-full)", border: "1px solid var(--border-subtle)", background: "var(--surface-raised)", fontWeight: 500, color: "var(--text-strong)", verticalAlign: "baseline" },
  plus: { fontSize: "var(--text-2xs)", padding: "1px 7px", borderRadius: "var(--radius-sm)", background: "var(--mint)", color: "var(--on-pastel)" },
  minus: { fontSize: "var(--text-2xs)", padding: "1px 7px", borderRadius: "var(--radius-sm)", background: "var(--peach)", color: "var(--on-pastel)" },
};

/** A marker no translation contains: where a slot goes in a translated sentence. */
const MARK = "\u0001";

export type AuditSettingsProps = {
  spaceId: string;
  members: Member[];
  roles: Role[];
};

/** The Journal tab: every change of rights in the space, newest first, filtered and paged. */
export function AuditSettings({ spaceId, members, roles }: AuditSettingsProps) {
  const { t } = useTranslation();
  const [actor, setActor] = useState("");
  const [category, setCategory] = useState("");
  const [period, setPeriod] = useState("30");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  const load = useCallback(
    async (before?: string) => {
      const days = PERIOD_DAYS[period];
      const since = days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
      try {
        const page = await getAudit(spaceId, { actor: actor || undefined, category: category || undefined, since, before, limit: 50 });
        setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
        setNext(page.next);
        setState("ready");
      } catch {
        setState("failed");
      }
    },
    [spaceId, actor, category, period],
  );

  useEffect(() => {
    // A change of filter starts the log again from its newest line.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("loading");
    void load();
  }, [load]);

  const colourOf = (name: string) => roles.find((r) => r.name === name)?.colour;

  const slot = (s: Slot): ReactNode => {
    switch (s.kind) {
      case "person":
        return <b style={{ color: "var(--text-strong)" }}>{s.name}</b>;
      case "deleted":
        return <b style={{ color: "var(--text-strong)" }}>{t("audit.deletedAccount")}</b>;
      case "role":
        return (
          <span style={st.chip}>
            <RoleDot role={{ colour: s.colour ?? colourOf(s.name) }} />
            {s.name}
          </span>
        );
      case "legacy":
        return <b style={{ color: "var(--text-strong)" }}>{s.roles.map((r) => t(ROLE_LABEL[r] ?? key("role.member"))).join(", ")}</b>;
    }
  };

  const sentence = (entry: AuditEntry): ReactNode => {
    const line = auditLine(entry);
    const fill: Record<string, string | number> = {};
    for (const name of Object.keys(line.slots)) fill[name] = `${MARK}${name}${MARK}`;
    for (const [name, value] of Object.entries(line.values)) fill[name] = name === "until" && typeof value === "string" ? formatDate(value) : value;
    if (line.sentence === "licenceInstalled") fill.count = line.values.seats;
    const text = t(SENTENCE[line.sentence], fill);
    // Every odd piece is a slot's name: the sentence keeps its own word order in every language.
    const pieces = text.split(MARK).map((piece, i) => (i % 2 === 1 && line.slots[piece] ? <Fragment key={i}>{slot(line.slots[piece])}</Fragment> : piece));
    const diff = line.diff;
    const label = (name: string) => (diff?.kind === "permission" ? (PERMISSION_TEXT[name] ? t(PERMISSION_TEXT[name].title) : name) : name);
    return (
      <>
        <span>{pieces}</span>
        {diff && (diff.added.length > 0 || diff.removed.length > 0) ? (
          <span style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
            {diff.added.map((name) => (
              <span key={`+${name}`} style={st.plus}>
                + {label(name)}
              </span>
            ))}
            {diff.removed.map((name) => (
              <span key={`-${name}`} style={st.minus}>
                {"−"} {label(name)}
              </span>
            ))}
          </span>
        ) : null}
      </>
    );
  };

  // Grouped by the reader's day, in the log's order (newest first).
  const groups: { day: string; at: string; entries: AuditEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayKey(entry.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, at: entry.at, entries: [entry] });
  }

  return (
    <>
      <h2 style={st.h}>{t("audit.title")}</h2>
      <p style={st.sub}>{t("audit.sub")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <div style={{ width: 190 }}>
          <Select
            size="sm"
            aria-label={t("audit.filterActor")}
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            options={[{ value: "", label: t("audit.everyone") }, ...members.filter((m) => !m.bot).map((m) => ({ value: m.userId, label: m.name }))]}
          />
        </div>
        <div style={{ width: 190 }}>
          <Select
            size="sm"
            aria-label={t("audit.filterCategory")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={[{ value: "", label: t("audit.allActions") }, ...Object.entries(CATEGORY).map(([value, label]) => ({ value, label: t(label) }))]}
          />
        </div>
        <div style={{ width: 180 }}>
          <Select
            size="sm"
            aria-label={t("audit.filterPeriod")}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            options={[
              { value: "7", label: t("audit.last7") },
              { value: "30", label: t("audit.last30") },
              { value: "90", label: t("audit.last90") },
              { value: "all", label: t("audit.always") },
            ]}
          />
        </div>
      </div>

      {state === "failed" ? (
        <p role="alert" style={{ ...st.sub, marginTop: 20, color: "var(--status-danger-fg)" }}>
          {t("audit.failed")}
        </p>
      ) : state === "ready" && entries.length === 0 ? (
        <p style={{ ...st.sub, marginTop: 20, color: "var(--text-muted)" }}>{t("audit.empty")}</p>
      ) : null}

      {groups.map((group) => (
        <div key={group.day}>
          <div style={st.day}>{group.day === "today" ? t("conversation.today") : formatDayHeading(group.at)}</div>
          <Card>
            {group.entries.map((entry, i) => (
              <div key={entry.id} style={{ ...st.row, borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
                <span style={st.time}>{formatTime(entry.at)}</span>
                {entry.actor ? (
                  <Avatar name={entry.actor.name} src={entry.actor.avatarUrl ?? getAvatar(entry.actor.name)} size={24} />
                ) : (
                  <Avatar name="?" size={24} />
                )}
                <span style={st.text}>{sentence(entry)}</span>
                {CATEGORY[entry.category] ? <Tag>{t(CATEGORY[entry.category])}</Tag> : null}
              </div>
            ))}
          </Card>
        </div>
      ))}

      {next ? (
        <div style={{ marginTop: 14 }}>
          <Button size="sm" variant="secondary" onClick={() => void load(next)}>
            {t("audit.more")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
