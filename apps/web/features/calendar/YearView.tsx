"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "@/lib/i18n";
import { capitalized, longDay, monthName, periodTitle, weekdayInitials } from "./format";
import { addDays, busyDays, weekOffset } from "./model";

/** Beyond this many events, a day's mark is filled rather than a dot. */
const BUSY = 3;

/**
 * The year as twelve small months. A day with events carries a dot, a full one (more than three) a
 * filled mark; today is in red. A day opens the day view, a month's name the month view.
 */
export function YearView({
  year,
  anchor,
  today,
  weekStart,
  occurrences,
  timeZone,
  onPickDay,
  onPickMonth,
}: {
  /** The year shown, as `2026`. */
  year: number;
  /** The day the screen is on: its month is scrolled into view when the year opens. */
  anchor: string;
  today: string;
  weekStart: number;
  /** The occurrences drawn in full (the filter applied). */
  occurrences: ReadonlyArray<{ allDay: boolean; start: string; end: string }>;
  timeZone: string;
  onPickDay: (day: string) => void;
  onPickMonth: (first: string) => void;
}) {
  const { t } = useTranslation();
  const counts = useMemo(() => busyDays(occurrences, timeZone), [occurrences, timeZone]);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
  const initials = weekdayInitials(weekStart);
  const scroller = useRef<HTMLDivElement>(null);
  // Open on the month the screen is on, not on January: on a phone, that is several screens down.
  const opening = anchor.slice(0, 7);
  useEffect(() => {
    const box = scroller.current;
    const month = box?.querySelector<HTMLElement>(`[data-month="${opening}"]`);
    if (box && month) box.scrollTop = Math.max(0, month.offsetTop - 12);
  }, [opening]);

  return (
    <div ref={scroller} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 14px 24px", position: "relative" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(156px, 1fr))", gap: "16px 20px" }}>
        {months.map((month) => {
          const first = addDays(month, -weekOffset(month, weekStart));
          const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
          // Six lines only when the month needs them.
          const lines = days.slice(35).some((d) => d.slice(0, 7) === month.slice(0, 7)) ? 6 : 5;
          return (
            <section key={month} data-month={month.slice(0, 7)} aria-label={capitalized(periodTitle("month", month))}>
              <button
                type="button"
                onClick={() => onPickMonth(month)}
                style={{
                  border: 0,
                  background: "none",
                  padding: "2px 4px",
                  margin: "0 0 4px -4px",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  fontWeight: 700,
                  color: month.slice(0, 7) === today.slice(0, 7) ? "var(--alarm)" : "var(--text-strong)",
                }}
              >
                {monthName(month)}
              </button>
              <div role="grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", rowGap: 1 }}>
                {initials.map((initial, i) => (
                  <span key={`h${i}`} aria-hidden style={{ textAlign: "center", fontSize: 10, color: "var(--text-muted)", paddingBottom: 2 }}>
                    {initial}
                  </span>
                ))}
                {days.slice(0, lines * 7).map((day) => {
                  if (day.slice(0, 7) !== month.slice(0, 7)) return <span key={day} aria-hidden />;
                  const count = counts.get(day) ?? 0;
                  const full = count > BUSY;
                  const isToday = day === today;
                  return (
                    <button
                      key={day}
                      type="button"
                      role="gridcell"
                      aria-label={count > 0 ? `${longDay(day)}, ${t("calendar.eventCount", { count })}` : longDay(day)}
                      onClick={() => onPickDay(day)}
                      className="wc-yearday"
                      style={{
                        position: "relative",
                        height: 26,
                        border: 0,
                        borderRadius: 999,
                        padding: 0,
                        cursor: "pointer",
                        fontSize: "var(--text-2xs)",
                        fontWeight: isToday || full ? 700 : 400,
                        background: full ? "color-mix(in srgb, var(--acc) 45%, transparent)" : "transparent",
                        color: isToday ? "var(--alarm)" : "var(--text-strong)",
                      }}
                    >
                      {Number(day.slice(8))}
                      {count > 0 && !full ? (
                        <span
                          aria-hidden
                          style={{ position: "absolute", left: "50%", bottom: 2, width: 4, height: 4, marginLeft: -2, borderRadius: "50%", background: "var(--ink)" }}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
