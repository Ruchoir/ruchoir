"use client";

import { type CSSProperties, useState } from "react";
import { Button, Dialog, Icon } from "@/components/ds";
import { refusalOf, setMemberRole } from "@/lib/data/api";
import type { Role } from "@/lib/data/types";
import { key, useTranslation, type TranslationKey } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { formatList } from "@/lib/i18n/format";
import { EndDateField } from "./EndDateField";
import { passerInvite, passerMembre } from "./guestActions.ts";
import { browserZone, choiceRefusal, endLabel, seatsAfterInvite, standingGain, standingLoss, type EndChoice, type Line } from "./guestLogic.ts";
import { refusalMessage } from "./roleChips";

type Person = { userId: string; name: string; title?: string; role: string; roleIds?: string[]; expiresAt?: string };

/** Each sentence of `guestLogic`'s lines, by its key. */
const LINES: Record<string, TranslationKey> = {
  "guests.loseView": key("guests.loseView"),
  "guests.loseDirectory": key("guests.loseDirectory"),
  "guests.loseCeiling": key("guests.loseCeiling"),
  "guests.keepChannels": key("guests.keepChannels"),
  "guests.keepMessages": key("guests.keepMessages"),
  "guests.keepGroups": key("guests.keepGroups"),
  "guests.keepRoles": key("guests.keepRoles"),
  "guests.gainView": key("guests.gainView"),
  "guests.gainSeat": key("guests.gainSeat"),
  "guests.gainClearsDate": key("guests.gainClearsDate"),
};

const col: Record<string, CSSProperties> = {
  card: { border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-card)", padding: "12px 14px", flex: "1 1 220px", minWidth: 0 },
  h: { margin: "0 0 8px", fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-strong)" },
  li: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-snug)", margin: "0 0 8px" },
};

function Sentences({ lines, tone }: { lines: Line[]; tone: "minus" | "check" }) {
  const { t } = useTranslation();
  return (
    <>
      {lines.map((l) => (
        <p key={l.key} style={col.li}>
          <Icon name={tone === "check" ? "check" : "minus"} size={13} style={{ flex: "none", marginTop: 2, color: tone === "check" ? "var(--status-success-fg)" : "var(--status-danger-fg)" }} />
          <span>{t(LINES[l.key], { roles: formatList(l.names ?? []) })}</span>
        </p>
      ))}
    </>
  );
}

/** Make a member a guest: what they lose, what they keep, an optional end date, and the seat it frees. */
export function PasserInviteDialog({
  member,
  roles,
  licence,
  spaceId,
  onClose,
  onChanged,
}: {
  member: Person;
  roles: Role[];
  licence?: { seats: number; used: number };
  spaceId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const zone = browserZone();
  const [now] = useState(() => new Date());
  const [choice, setChoice] = useState<EndChoice>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { loses, keeps } = standingLoss(member, roles);
  const seats = seatsAfterInvite(licence);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await passerInvite({ setMemberRole }, { spaceId, userId: member.userId, choice, now: new Date(), zone }, onChanged);
      onClose();
    } catch (err) {
      setError(refusalMessage(refusalOf(err), t, t("guests.passerFailed"), "members"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("guests.passerInviteTitle", { name: member.name })}
      closeLabel={t("common.close")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="primary" iconLeft="repeat" disabled={busy || choiceRefusal(choice, now, zone) !== null} onClick={() => void go()}>
            {busy ? t("common.sending") : t("guests.passerInviteAction")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{[member.title, t("guests.memberToday")].filter(Boolean).join(" · ")}</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ ...col.card, background: "var(--surface-sunken)" }}>
            <h4 style={col.h}>{t("guests.loses")}</h4>
            <Sentences lines={loses} tone="minus" />
          </div>
          <div style={col.card}>
            <h4 style={col.h}>{t("guests.keeps")}</h4>
            <Sentences lines={keeps} tone="check" />
          </div>
        </div>
        <EndDateField choice={choice} onChange={setChoice} now={now} zone={zone} variant="invite" />
        {seats ? (
          <p style={{ ...col.li, margin: 0, color: "var(--text-muted)" }}>
            <Icon name="users" size={13} style={{ flex: "none", marginTop: 2 }} />
            <span>{t("guests.seatsAfter", seats)}</span>
          </p>
        ) : null}
        {error ? <p role="alert" style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--status-danger-fg)" }}>{error}</p> : null}
      </div>
    </Dialog>
  );
}

/** Make a guest a member: it takes a seat and clears the date; a full licence is answered, not thrown. */
export function PasserMembreDialog({
  member,
  spaceId,
  onClose,
  onChanged,
}: {
  member: Person;
  spaceId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState<{ seats: number; pricingUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locale = currentLocale();
  const gain = standingGain(member);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await passerMembre({ setMemberRole }, { spaceId, userId: member.userId }, onChanged);
      if (outcome.ok) onClose();
      else {
        setFull(outcome.seatsFull);
        setBusy(false);
      }
    } catch (err) {
      setError(refusalMessage(refusalOf(err), t, t("guests.passerFailed"), "members"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("guests.passerMembreTitle", { name: member.name })}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{full ? t("common.close") : t("common.cancel")}</Button>
          <Button variant="primary" iconLeft="repeat" disabled={busy || full !== null} onClick={() => void go()}>
            {busy ? t("common.sending") : t("guests.passerMembreAction")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
          {[member.title, member.expiresAt ? t("guests.guestUntil", { date: endLabel(member.expiresAt, locale, browserZone()) }) : t("guests.guestNoEnd")].filter(Boolean).join(" · ")}
        </div>
        {full ? (
          <div role="alert" style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: "var(--radius-item)", background: "var(--status-warning-bg)", border: "1px solid var(--status-warning-border)", color: "var(--status-warning-fg)", fontSize: "var(--text-xs)" }}>
            <Icon name="alert-triangle" size={16} style={{ flex: "none", marginTop: 1 }} />
            <span>
              <b>{t("dialogs.seatsFull", { count: full.seats })}</b> {t("guests.seatsFullRest", { name: member.name })}
              {full.pricingUrl ? (
                <>
                  <br />
                  <a className="wc-btn wc-btn--link wc-btn--sm" style={{ padding: 0, marginTop: 6 }} href={full.pricingUrl} target="_blank" rel="noreferrer">
                    {t("roles.seePricing")}
                    <Icon name="external-link" size={13} />
                  </a>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
        <div>
          {gain.map((l) => (
            <p key={l.key} style={col.li}>
              <Icon name="info" size={13} style={{ flex: "none", marginTop: 2 }} />
              <span>{t(LINES[l.key])}</span>
            </p>
          ))}
        </div>
        {error ? <p role="alert" style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--status-danger-fg)" }}>{error}</p> : null}
      </div>
    </Dialog>
  );
}
