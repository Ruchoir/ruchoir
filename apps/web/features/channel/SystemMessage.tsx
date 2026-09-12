import { Icon } from "@/components/ds";
import type { Message, SystemEvent } from "@/lib/data";
import { formatStamp } from "@/lib/i18n/format";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";

/** The sentence for each event, as a key: the words belong to whoever is reading the channel. */
const EVENT_TEXT: Record<SystemEvent, TranslationKey> = {
  member_joined: key("system.memberJoined"),
  member_left: key("system.memberLeft"),
  channel_joined: key("system.channelJoined"),
  channel_left: key("system.channelLeft"),
  channel_created: key("system.channelCreated"),
};

/** Centered notice for join/leave and similar system events. */
export function SystemMessage({ m }: { m: Message }) {
  const { t } = useTranslation();
  const said = m.system
    ? t(EVENT_TEXT[m.system.event], { who: m.system.actor || t("invite.someone") })
    : m.body;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        margin: "10px 0",
        fontSize: 12,
        color: "var(--text-subtle)",
      }}
    >
      {m.systemIcon ? <Icon name={m.systemIcon} size={13} /> : null}
      <span>{said}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatStamp(m.createdAt)}</span>
    </div>
  );
}
