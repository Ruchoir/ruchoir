"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, Icon } from "@/components/ds";
import { getEvent, respondToEvent, type AttendeeStatus, type EventCard } from "@/lib/data/calendar";
import type { Message } from "@/lib/data";
import { formatStamp } from "@/lib/i18n/format";
import { useTranslation } from "@/lib/i18n";
import { STATUS_LOOK } from "./AttendeesField";
import { whenText } from "./EventDetails";
import { shortMonth } from "./format";
import { localDay } from "./model";

const ANSWERS = ["accepted", "tentative", "declined"] as const;

const notice: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  margin: "10px 0",
  textAlign: "center",
  fontSize: "var(--text-2xs)",
  color: "var(--text-subtle)",
};

/**
 * An event in a channel. Planned or linked here, it is a card drawn as the event stands now: when its
 * next date is, where, who organises it, and, for someone invited, their answer in three buttons
 * (for every date of a series). A change of time or place, or a cancellation, is a line like the
 * channel's other notices, the change with a way to the event.
 *
 * The card reaches whoever is in the channel at once, without each reader's answer: an invitee's is
 * then read from the event itself.
 */
export function EventCardMessage({
  m,
  timeZone,
  viewerId,
  compact,
  onOpen,
}: {
  m: Message;
  timeZone: string;
  viewerId?: string;
  compact?: boolean;
  onOpen: (card: EventCard) => void;
}) {
  const { t } = useTranslation();
  const card = m.eventCard;
  const [status, setStatus] = useState<AttendeeStatus | undefined>(card?.myStatus);
  const [answering, setAnswering] = useState(false);
  const [failed, setFailed] = useState(false);
  const organizer = Boolean(card && viewerId && card.organizerId === viewerId);
  const posted = m.system?.event === "calendar_event_posted";

  // A card just received carries nobody's answer: read the reader's own from the event.
  useEffect(() => {
    if (!posted || !card || !m.fresh || card.myStatus !== undefined || !viewerId || organizer) return;
    const abort = new AbortController();
    getEvent(card.eventId, abort.signal)
      .then((event) => setStatus(event.attendees.find((a) => a.userId === viewerId)?.status))
      .catch(() => {});
    return () => abort.abort();
  }, [posted, card, m.fresh, viewerId, organizer]);

  const who = m.system?.actor || t("invite.someone");
  const title = m.body;
  if (!posted || !card) {
    const key =
      m.system?.event === "calendar_event_cancelled"
        ? "system.calendarEventCancelled"
        : m.system?.event === "calendar_event_changed"
          ? "system.calendarEventChanged"
          : "system.calendarEventPosted";
    return (
      <div style={notice}>
        {m.systemIcon ? <Icon name={m.systemIcon} size={13} style={{ flex: "none" }} /> : null}
        <span>
          {t(key, { who, detail: title })}{" "}
          {card ? (
            <button type="button" onClick={() => onOpen(card)} style={{ border: 0, background: "none", padding: 0, color: "var(--text-link)", font: "inherit", cursor: "pointer", textDecoration: "underline" }}>
              {t("calendar.seeEvent")}
            </button>
          ) : null}{" "}
          <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatStamp(m.createdAt)}</span>
        </span>
      </div>
    );
  }

  // Read in the viewer's zone, as the calendar and the channel's upcoming events are.
  const day = card.allDay ? card.start : localDay(card.start, timeZone);
  const answer = async (next: (typeof ANSWERS)[number]) => {
    setAnswering(true);
    setFailed(false);
    try {
      await respondToEvent(card.eventId, next);
      setStatus(next);
    } catch {
      setFailed(true);
    } finally {
      setAnswering(false);
    }
  };
  const invited = status !== undefined && !organizer;

  return (
    <div style={{ margin: compact ? "10px 0" : "10px 0 10px 50px", display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-2xs)", color: "var(--text-subtle)" }}>
        <Icon name="calendar" size={13} />
        <span>{t("system.calendarEventPosted", { who, detail: card.title })}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatStamp(m.createdAt)}</span>
      </div>
      <article
        aria-label={card.title}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 12,
          borderRadius: "var(--radius-md)",
          border: "1.5px solid var(--border-subtle)",
          background: "var(--surface-card)",
        }}
      >
        <button
          type="button"
          onClick={() => onOpen(card)}
          style={{ display: "flex", gap: 12, alignItems: "flex-start", border: 0, background: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "inherit", font: "inherit" }}
        >
          <span
            aria-hidden
            style={{
              flex: "none",
              width: 46,
              borderRadius: "var(--radius-sm)",
              overflow: "hidden",
              border: "1.5px solid var(--border-subtle)",
              textAlign: "center",
              background: "var(--surface)",
            }}
          >
            <span style={{ display: "block", background: "var(--acc)", color: "var(--on-pastel)", fontSize: "var(--text-2xs)", fontWeight: 700, textTransform: "uppercase", padding: "1px 0" }}>{shortMonth(day)}</span>
            <span style={{ display: "block", fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text-strong)", padding: "2px 0 3px" }}>{Number(day.slice(8, 10))}</span>
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <span style={{ fontSize: "var(--text-md)", fontWeight: 700, color: "var(--text-strong)", overflowWrap: "anywhere" }}>{card.title}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
              <Icon name="clock" size={13} />
              {whenText(card, timeZone)}
              {card.recurring ? <Icon name="repeat" size={13} title={t("calendar.repeats")} /> : null}
            </span>
            {card.location ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                <Icon name="map-pin" size={13} />
                {card.location}
              </span>
            ) : null}
            {card.organizer ? <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("calendar.organizedBy", { name: organizer ? t("calendar.me") : card.organizer })}</span> : null}
          </span>
        </button>
        {invited ? (
          <div role="group" aria-label={t("calendar.yourAnswer")} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {ANSWERS.map((a) => {
              const on = status === a;
              return (
                <Button key={a} size="sm" variant={on ? "primary" : "secondary"} iconLeft={STATUS_LOOK[a].icon} aria-pressed={on} disabled={answering} onClick={() => void answer(a)}>
                  {t(`calendar.answer.${a}`)}
                </Button>
              );
            })}
            {card.recurring ? <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{t("calendar.answerSeries")}</span> : null}
            {failed ? (
              <span role="alert" style={{ fontSize: "var(--text-2xs)", color: "var(--action-danger-bg)" }}>
                {t("calendar.actionFailed")}
              </span>
            ) : null}
          </div>
        ) : null}
      </article>
    </div>
  );
}
