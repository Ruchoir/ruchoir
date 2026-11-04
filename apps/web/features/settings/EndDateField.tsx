"use client";

import { type CSSProperties } from "react";
import { Button, Icon, Input, Tag } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { choiceRefusal, dateBounds, endLabel, presetToInstant, type EndChoice } from "./guestLogic.ts";

const s: Record<string, CSSProperties> = {
  card: { border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-card)", padding: "12px 14px", background: "var(--surface-raised)", display: "flex", flexDirection: "column", gap: 10 },
  head: { display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" },
  note: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: { borderRadius: 999 },
  result: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-item)", fontSize: "var(--text-sm)", color: "var(--text-strong)", fontWeight: 600 },
  resultHint: { marginLeft: "auto", fontSize: "var(--text-2xs)", fontWeight: 400, color: "var(--text-muted)" },
  foot: { display: "flex", gap: 6, alignItems: "flex-start", fontSize: "var(--text-2xs)", color: "var(--text-muted)", lineHeight: "var(--leading-snug)" },
  error: { margin: 0, fontSize: "var(--text-2xs)", color: "var(--status-danger-fg)" },
};

export type EndDateVariant = "invite" | "extend" | "reactivate";

/**
 * The end of a guest's access: ready-made durations, no date, or a day picked by hand. Drawn the same
 * when inviting, when prolonging and when reactivating; the three differ only in the words around it
 * and in whether the durations count from the current end (`base`). It holds no state: the caller
 * keeps the choice and turns it into an instant with `presetToInstant`.
 */
export function EndDateField({
  choice,
  onChange,
  now,
  zone,
  variant,
  base,
}: {
  choice: EndChoice;
  onChange: (choice: EndChoice) => void;
  now: Date;
  zone: string;
  variant: EndDateVariant;
  /** The current end (RFC 3339), for `extend`: a duration is added to it. */
  base?: string | null;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const extend = variant === "extend";
  const custom = typeof choice === "object";
  const refusal = choiceRefusal(choice, now, zone);
  const instant = refusal === null ? presetToInstant(choice, now, zone, extend ? base : null) : null;
  const bounds = dateBounds(now, zone);

  const chip = (label: string, selected: boolean, value: EndChoice, icon?: "calendar") => (
    <Button
      key={label}
      size="sm"
      variant={selected ? "primary" : "secondary"}
      iconLeft={icon}
      aria-pressed={selected}
      style={s.chip}
      onClick={() => onChange(value)}
    >
      {label}
    </Button>
  );
  const none = chip(extend ? t("guests.presetNoEnd") : t("guests.presetNone"), choice === "none", "none");
  const durations = [
    chip(t("guests.presetWeek"), choice === "week", "week"),
    chip(t("guests.presetMonth"), choice === "month", "month"),
    chip(t("guests.presetQuarter"), choice === "quarter", "quarter"),
  ];
  const picker = chip(t("guests.presetCustom"), custom, { date: custom ? choice.date : "" }, "calendar");

  const body = (
    <>
      <div style={s.chips} role="group" aria-label={extend ? t("guests.prolongBy") : t("guests.endTitle")}>
        {extend ? [...durations, picker, none] : [none, ...durations, picker]}
      </div>
      {custom ? (
        <div>
          <Input
            type="date"
            size="sm"
            aria-label={t("guests.dateLabel")}
            value={choice.date}
            min={bounds.min}
            max={bounds.max}
            invalid={refusal === "past" || refusal === "far"}
            onChange={(e) => onChange({ date: e.target.value })}
          />
          {refusal === "past" || refusal === "far" ? (
            <p role="alert" style={{ ...s.error, marginTop: 4 }}>{refusal === "past" ? t("guests.pastDate") : t("guests.farDate")}</p>
          ) : null}
        </div>
      ) : null}
      {instant ? (
        <div style={s.result}>
          <Icon name="calendar-clock" size={16} />
          <span>{endLabel(instant, locale, zone)}</span>
          <span style={s.resultHint}>{extend ? t("guests.newDate") : t("guests.endOfDay")}</span>
        </div>
      ) : extend && choice === "none" ? (
        <div style={s.result}>
          <Icon name="calendar-clock" size={16} />
          <span>{t("guests.newNoEnd")}</span>
        </div>
      ) : null}
      {extend && instant ? (
        <div style={s.foot}>
          <Icon name="bell" size={13} style={{ flex: "none", marginTop: 1 }} />
          <span>{t("guests.prolongReminders")}</span>
        </div>
      ) : null}
      {variant === "invite" && instant ? (
        <div style={s.foot}>
          <Icon name="bell" size={13} style={{ flex: "none", marginTop: 1 }} />
          <span>{t("guests.reminders")}</span>
        </div>
      ) : null}
    </>
  );

  if (extend) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-strong)" }}>{t("guests.prolongBy")}</div>
        {body}
      </div>
    );
  }
  return (
    <div style={s.card}>
      <div style={s.head}>
        <Icon name="calendar-clock" size={16} />
        <span>{t("guests.endTitle")}</span>
        {variant === "invite" ? <Tag>{t("guests.optional")}</Tag> : null}
      </div>
      {variant === "invite" ? <p style={s.note}>{t("guests.endNote")}</p> : null}
      {body}
    </div>
  );
}
