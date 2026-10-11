"use client";

import { type CSSProperties, useState } from "react";
import { Button, Icon, IconButton, Input, Select } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { customMinutes, MAX_REMINDERS, presetReminders, reminderLabel, remindersLabel, type ReminderUnit } from "./reminders";

const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 4px 2px 10px",
  borderRadius: 999,
  background: "var(--surface-sunken)",
  border: "1px solid var(--border-subtle)",
  fontSize: "var(--text-xs)",
  color: "var(--text-strong)",
};

/**
 * A list of reminders: each one a label with its cross, then a menu adding one of the usual delays
 * or one of one's own, five at most. With `inherited`, "as the calendar" is a choice too: the field
 * then shows what the calendar gives until someone chooses their own, and offers to go back to it.
 */
export function RemindersField({
  id,
  value,
  onChange,
  allDay,
  inherited,
}: {
  id: string;
  /** The reminders chosen; `undefined` follows `inherited`. */
  value: number[] | undefined;
  onChange: (next: number[] | undefined) => void;
  allDay: boolean;
  /** What following the calendar gives, when following it is a choice here. */
  inherited?: number[];
}) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(false);
  const [count, setCount] = useState("1");
  const [unit, setUnit] = useState<ReminderUnit>("hours");

  if (value === undefined) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
          {t("calendar.reminderFollowsCalendar", { label: remindersLabel(inherited ?? [], t, allDay) })}
        </span>
        <Button type="button" size="sm" variant="ghost" iconLeft="square-pen" onClick={() => onChange([...(inherited ?? [])])}>
          {t("calendar.reminderPersonalize")}
        </Button>
      </div>
    );
  }

  // Earliest first: the order they ring in.
  const shown = [...value].sort((a, b) => b - a);
  const full = value.length >= MAX_REMINDERS;
  const offered = presetReminders(allDay).filter((m) => !value.includes(m));
  const add = (minutes: number | null) => {
    if (minutes === null || value.includes(minutes) || full) return;
    onChange([...value, minutes]);
    setCustom(false);
  };
  const typed = customMinutes(Number(count), allDay ? "days" : unit, allDay);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {shown.length === 0 ? <span style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{t("calendar.reminderNone")}</span> : null}
        {shown.map((m) => (
          <span key={m} style={chip}>
            <Icon name="bell" size={12} />
            {reminderLabel(m, t, allDay)}
            <IconButton
              icon="x"
              size="sm"
              label={t("calendar.reminderRemove", { label: reminderLabel(m, t, allDay) })}
              onClick={() => onChange(value.filter((k) => k !== m))}
            />
          </span>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {full ? (
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{t("calendar.remindersMax")}</span>
        ) : (
          <div style={{ flex: "0 1 220px", minWidth: 0 }}>
            <Select
              id={id}
              size="sm"
              aria-label={t("calendar.addReminder")}
              value=""
              onChange={(e) => {
                if (e.target.value === "custom") setCustom(true);
                else if (e.target.value) add(Number(e.target.value));
              }}
              options={[
                { value: "", label: `+ ${t("calendar.addReminder")}` },
                ...offered.map((m) => ({ value: String(m), label: reminderLabel(m, t, allDay) })),
                { value: "custom", label: t("calendar.customReminder") },
              ]}
              style={{ width: "100%" }}
            />
          </div>
        )}
        {inherited !== undefined ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            {t("calendar.reminderBackToCalendar")}
          </Button>
        ) : null}
      </div>
      {custom && !full ? (
        <div role="group" aria-label={t("calendar.customReminder")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <div style={{ flex: "0 0 76px" }}>
            <Input
              id={`${id}-count`}
              size="sm"
              type="number"
              min={allDay ? 1 : 0}
              max={allDay ? 28 : undefined}
              value={count}
              aria-label={t("calendar.reminderCount")}
              onChange={(e) => setCount(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          {allDay ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>{t("calendar.reminderDaysAt9Unit")}</span>
          ) : (
            <div style={{ flex: "0 1 170px", minWidth: 0 }}>
              <Select
                id={`${id}-unit`}
                size="sm"
                aria-label={t("calendar.customReminder")}
                value={unit}
                onChange={(e) => setUnit(e.target.value as ReminderUnit)}
                options={(["minutes", "hours", "days", "weeks"] as const).map((u) => ({ value: u, label: t(`calendar.reminderUnit.${u}`) }))}
                style={{ width: "100%" }}
              />
            </div>
          )}
          <Button type="button" size="sm" variant="secondary" disabled={typed === null || value.includes(typed)} onClick={() => add(typed)}>
            {t("calendar.reminderAdd")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
