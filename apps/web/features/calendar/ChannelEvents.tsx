"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ds";
import { listChannelEvents, type UpcomingEvent } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { clock, shortDay } from "./format";
import { localDay } from "./model";

/**
 * A channel's next linked events, under its header: three at most, within two months, each opening
 * the event. Nothing at all when there are none, so a channel that plans nothing looks as before.
 *
 * Read again when `version` changes: the screen bumps it when a calendar card arrives, which is when
 * the list may have changed.
 */
export function ChannelEvents({
  channelId,
  version,
  timeZone,
  onOpen,
}: {
  channelId: string;
  version: string;
  timeZone: string;
  onOpen: (event: UpcomingEvent) => void;
}) {
  const { t } = useTranslation();
  const [found, setFound] = useState<{ channelId: string; list: UpcomingEvent[] } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    listChannelEvents(channelId, abort.signal)
      .then((list) => setFound({ channelId, list }))
      .catch(() => {
        if (!abort.signal.aborted) setFound({ channelId, list: [] });
      });
    return () => abort.abort();
  }, [channelId, version]);

  const list = found?.channelId === channelId ? found.list : [];
  if (list.length === 0) return null;
  const today = localDay(new Date().toISOString(), timeZone);
  const when = (u: UpcomingEvent) => {
    const day = u.allDay ? u.start : localDay(u.start, timeZone);
    const short = shortDay(day);
    const date = day === today ? t("conversation.today") : `${short.weekday} ${short.date}`;
    return u.allDay ? date : `${date} · ${clock(u.start, timeZone)}`;
  };

  return (
    <nav
      aria-label={t("calendar.upcomingInChannel")}
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderBottom: "1px solid var(--border-subtle)",
        overflowX: "auto",
        scrollbarWidth: "none",
        background: "var(--surface)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", fontSize: "var(--text-2xs)", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        <Icon name="calendar" size={13} />
        {t("calendar.upcoming")}
      </span>
      {list.map((u) => (
        <button
          key={`${u.eventId}/${u.recurrenceId ?? ""}`}
          type="button"
          onClick={() => onOpen(u)}
          style={{
            flex: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 280,
            padding: "3px 10px",
            borderRadius: 999,
            border: "1px solid var(--border-subtle)",
            background: "var(--surface-card)",
            color: "var(--text-strong)",
            fontSize: "var(--text-xs)",
            cursor: "pointer",
          }}
        >
          <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flex: "none" }}>{when(u)}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{u.title}</span>
        </button>
      ))}
    </nav>
  );
}
