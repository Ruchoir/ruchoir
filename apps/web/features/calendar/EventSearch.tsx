"use client";

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { Dialog, EmptyState, Icon, Skeleton, SkeletonGroup } from "@/components/ds";
import { type CalendarColor, type Occurrence, searchEvents } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { foundWhen } from "./format";
import { localDay } from "./model";
import { colorVar } from "./OccurrenceChip";

const row: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  width: "100%",
  padding: "8px 10px",
  border: 0,
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
  textAlign: "left",
};

/** The events whose words hold `query`, read a quarter of a second after the last keystroke. */
export function useEventSearch(query: string): { hits: Occurrence[]; loading: boolean } {
  const [hits, setHits] = useState<Occurrence[]>([]);
  const [loading, setLoading] = useState(false);
  const q = query.trim();
  // Resetting the results as the words change is the synchronization this effect is for.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const handle = setTimeout(() => {
      searchEvents(q, controller.signal)
        .then((found) => {
          setHits(found);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [q]);
  /* eslint-enable react-hooks/set-state-in-effect */
  return { hits, loading };
}

/** One event found: its calendar's colour, its title, when, and where. */
export function EventHitRow({
  occurrence,
  timeZone,
  color,
  selected,
  idx,
  onSelect,
  onOpen,
}: {
  occurrence: Occurrence;
  timeZone: string;
  /** Its calendar's colour, when the screen knows the calendar. */
  color?: CalendarColor;
  selected: boolean;
  idx: number;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const today = localDay(new Date().toISOString(), timeZone);
  const when = foundWhen(occurrence, timeZone, today);
  return (
    <button
      type="button"
      className="wc-listrow"
      data-idx={idx}
      style={{ ...row, background: selected ? "var(--surface-selected)" : "transparent" }}
      onMouseMove={onSelect}
      onClick={onOpen}
    >
      {color ? (
        <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, background: colorVar(color), flex: "none", marginTop: 4 }} />
      ) : (
        <Icon name="calendar" size={18} style={{ color: "var(--text-muted)", flex: "none" }} />
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {occurrence.title}
        </span>
        <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {occurrence.location ? `${when} · ${occurrence.location}` : when}
        </span>
      </span>
    </button>
  );
}

/** The skeleton of a few results, while the first ones are read. */
export function EventHitsLoading() {
  const { t } = useTranslation();
  return (
    <SkeletonGroup label={t("search.querying")} style={{ padding: "6px 12px" }}>
      {[0.7, 0.5, 0.6].map((width, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
          <Skeleton width={`${width * 60}%`} height={10} />
          <Skeleton width={`${width * 100}%`} height={10} />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/**
 * Searching the calendar: every event the viewer sees, past and future, by its title, place, notes
 * or guests. Choosing one opens it at its date.
 */
export function CalendarSearchDialog({
  timeZone,
  colorOf,
  onOpen,
  onClose,
}: {
  timeZone: string;
  colorOf: (calendarId: string) => CalendarColor | undefined;
  onOpen: (occurrence: Occurrence) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { hits, loading } = useEventSearch(query);
  const q = query.trim();

  const move = (to: number) => {
    const next = Math.max(0, Math.min(hits.length - 1, to));
    setActive(next);
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(active - 1);
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      onOpen(hits[active]);
    }
  };

  return (
    <Dialog title={t("calendar.searchEvents")} size="md" onClose={onClose} closeLabel={t("common.close")} className="wc-dlg--search">
      <div className="wc-inp wc-inp--lg" style={{ marginBottom: 4 }}>
        <Icon name="search" size={18} style={{ color: "var(--text-subtle)" }} />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          aria-label={t("calendar.searchEvents")}
          placeholder={t("calendar.searchEventsPlaceholder")}
          style={{
            flex: 1,
            border: 0,
            outline: "none",
            background: "none",
            fontFamily: "inherit",
            // 16px: below it, a phone zooms the whole page in to type.
            fontSize: "var(--text-base)",
            color: "var(--text-strong)",
          }}
        />
      </div>
      <div ref={listRef} className="wc-search-results" role="list" style={{ overflow: "auto" }}>
        {!q ? (
          <EmptyState size="compact" icon="calendar" description={t("calendar.searchEventsPrompt")} />
        ) : hits.length === 0 && loading ? (
          <EventHitsLoading />
        ) : hits.length === 0 ? (
          <EmptyState size="compact" icon="search" title={t("search.noResult")} description={t("switcher.noMatch", { query })} />
        ) : (
          hits.map((o, i) => (
            <EventHitRow
              key={`${o.eventId}:${o.recurrenceId ?? ""}`}
              occurrence={o}
              timeZone={timeZone}
              color={colorOf(o.calendarId)}
              selected={i === active}
              idx={i}
              onSelect={() => setActive(i)}
              onOpen={() => onOpen(o)}
            />
          ))
        )}
      </div>
    </Dialog>
  );
}
