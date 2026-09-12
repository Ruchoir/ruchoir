import type { CSSProperties } from "react";
import { Avatar, Button, Icon, Tag } from "@/components/ds";
import type { Presence } from "@/components/ds";
import { getCurrentUser } from "@/lib/data";
import { presenceLabel } from "./presence";
import { useProfile } from "./useProfile";
import { useLocalTime } from "./useLocalTime";
import { useTranslation } from "@/lib/i18n";
import { languageName } from "@/lib/i18n/config";

const card: CSSProperties = {
  width: 280,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-popover)",
  overflow: "hidden",
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "var(--text-muted)",
};

export type UserProfileCardProps = {
  name: string;
  /** User id, when known: enables fetching the real profile. */
  userId?: string;
  /** Live presence for the member. */
  presence?: Presence;
  onViewFull: () => void;
  onEditProfile: () => void;
  onMessage: () => void;
};

/** Compact profile shown in a popover when a user is clicked in the feed. */
export function UserProfileCard({ name, userId, presence, onViewFull, onEditProfile, onMessage }: UserProfileCardProps) {
  const p = useProfile(userId, name);
  const dot = presence ?? p.presence;
  const { t, i18n } = useTranslation();
  const localTime = useLocalTime(p.timezone);
  const isOwn = name === getCurrentUser().name;
  return (
    <div style={card}>
      <div style={{ height: 44, background: "var(--surface-sunken)", borderBottom: "1px solid var(--border-subtle)" }} />
      <div style={{ padding: "0 16px 14px", marginTop: -22 }}>
        <Avatar name={p.name} src={p.avatarUrl} size={56} presence={dot} kind={p.bot ? "bot" : "person"} />
        <div style={{ marginTop: 8, fontSize: 17, fontWeight: 600, color: "var(--text-strong)" }}>
          {p.name}
          {p.pronouns ? (
            <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-subtle)", marginLeft: 6 }}>
              ({p.pronouns})
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 1 }}>{p.role}</div>
        {/* Who to ask when an account has to be handed back: without this the recovery instructions
            name a person nobody can pick out. */}
        {p.instanceAdmin ? (
          <div style={{ marginTop: 8 }}>
            <Tag tone="accent" icon="shield">
              {t("admin.instanceAdminBadge")}
            </Tag>
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
          <div style={row}>
            <span style={{ width: 8, height: 8, borderRadius: "var(--radius-full)", background: `var(--presence-${dot})` }} />
            {presenceLabel(dot)}
          </div>
          {/* Only when they chose a timezone: the card used to fall back to Europe/Paris and present
              it as this person's local time, which is worse than saying nothing. */}
          {localTime ? (
            <div style={row}>
              <Icon name="clock" size={14} />
              {localTime} heure locale
            </div>
          ) : null}
          {p.email ? (
            <div style={{ ...row, minWidth: 0 }}>
              <Icon name="at-sign" size={14} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.email}</span>
            </div>
          ) : null}
          {/* The language they read, named in the reader's own. Worth knowing before writing. */}
          {p.locale ? (
            <div style={row}>
              <Icon name="languages" size={14} />
              {languageName(p.locale, i18n.language)}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {isOwn ? (
            <Button variant="secondary" size="sm" iconLeft="square-pen" onClick={onEditProfile} fullWidth>
              Modifier le profil
            </Button>
          ) : (
            <>
              <Button variant="primary" size="sm" iconLeft="message-square" onClick={onMessage} fullWidth>
                Message
              </Button>
              <Button variant="secondary" size="sm" onClick={onViewFull}>
                Profil
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
