"use client";

import { useState } from "react";
import { Button, Dialog, Icon } from "@/components/ds";
import { refusalOf, setGuestExpiry } from "@/lib/data/api";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import type { Toast } from "../app/types";
import { EndDateField } from "./EndDateField";
import { saveGuestExpiry } from "./guestActions.ts";
import { browserZone, choiceRefusal, daysLeft, endLabel, expiryTone, inDaysLabel, type EndChoice } from "./guestLogic.ts";
import { refusalMessage } from "./roleChips";

export type ProlongGuest = { userId: string; name: string; title?: string; expiresAt?: string };

/**
 * Move a guest's end date, or remove it: a duration added to the current end, a day picked by hand,
 * or no end at all. The new date is written out in full and the reminders start over for it (the
 * server does that; the dialog says so).
 */
export function ProlongDialog({
  guest,
  spaceId,
  onClose,
  onSaved,
  onNotify,
}: {
  guest: ProlongGuest;
  spaceId: string;
  onClose: () => void;
  /** The date was saved: read the people again. */
  onSaved: () => Promise<void>;
  onNotify: (toast: Toast) => void;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const zone = browserZone();
  const [now] = useState(() => new Date());
  const [choice, setChoice] = useState<EndChoice>("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = guest.expiresAt ? daysLeft(guest.expiresAt, now) : null;
  const soon = days !== null && expiryTone(days) === "soon";
  const blocked = choiceRefusal(choice, now, zone) !== null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveGuestExpiry({ setGuestExpiry }, { spaceId, userId: guest.userId, choice, now: new Date(), zone, base: guest.expiresAt }, onSaved);
      onNotify({ tone: "success", title: t("guests.updated"), description: guest.name });
      onClose();
    } catch (err) {
      setError(refusalMessage(refusalOf(err), t, t("guests.updateFailed"), "members"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("guests.prolongTitle")}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" iconLeft="check" disabled={busy || blocked} onClick={() => void save()}>
            {busy ? t("common.sending") : t("common.save")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{[guest.name, guest.title].filter(Boolean).join(" · ")}</div>
        {guest.expiresAt && days !== null ? (
          <div
            style={{
              display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--radius-item)", fontSize: "var(--text-xs)",
              background: soon ? "var(--status-warning-bg)" : "var(--surface-sunken)",
              border: `1px solid ${soon ? "var(--status-warning-border)" : "var(--border-subtle)"}`,
              color: soon ? "var(--status-warning-fg)" : "var(--text-body)",
            }}
          >
            <Icon name={soon ? "alert-triangle" : "calendar-clock"} size={16} style={{ flex: "none", marginTop: 1 }} />
            <span>
              <b style={{ display: "block", fontSize: "var(--text-sm)" }}>{t("guests.endsOn", { date: endLabel(guest.expiresAt, locale, zone) })}</b>
              {t("guests.endsInfo", { when: inDaysLabel(days, locale), name: guest.name })}
            </span>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>{t("guests.noEndInfo")}</p>
        )}
        <EndDateField choice={choice} onChange={setChoice} now={now} zone={zone} variant="extend" base={guest.expiresAt} />
        {error ? (
          <p role="alert" style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--status-danger-fg)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
