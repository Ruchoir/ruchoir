"use client";

import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { Avatar, Button, Dialog, Icon } from "@/components/ds";
import { type EndedAccess as Ended, listEndedAccess, reactivateGuest, refusalOf, removeMember } from "@/lib/data/api";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { RemoveMemberDialog } from "../app/dialogs";
import type { Toast } from "../app/types";
import { EndDateField } from "./EndDateField";
import { askRemoval, confirmRemoval, reactivateGuestAccess, type Removal } from "./guestActions.ts";
import { displayZone, canSeeEnded, choiceRefusal, endLabel, keepLabel, type EndChoice } from "./guestLogic.ts";
import { refusalMessage } from "./roleChips";

const st: Record<string, CSSProperties> = {
  wrap: { marginTop: 18, border: "1px dashed var(--border-default)", borderRadius: "var(--radius-card)", padding: "4px 14px 10px" },
  toggle: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 0", border: 0, background: "transparent", cursor: "pointer", fontFamily: "var(--font-sans)", color: "var(--text-strong)", textAlign: "left" },
  title: { fontSize: "var(--text-md)", fontWeight: 700 },
  count: { fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", background: "var(--surface-sunken)", borderRadius: 999, padding: "1px 8px" },
  keep: { fontSize: "var(--text-xs)", color: "var(--text-muted)" },
  note: { margin: "0 0 10px", fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-snug)", maxWidth: 560 },
  row: { display: "flex", alignItems: "center", gap: 12, padding: "10px 0", flexWrap: "wrap", borderTop: "1px solid var(--border-subtle)" },
  name: { fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" },
  sub: { fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  ended: { width: 200, flex: "none", display: "flex", flexDirection: "column", gap: 2 },
};

/**
 * Guests whose access ended, kept ninety days: reactivate with a new end date, or remove for good.
 * Collapsed until opened, and nothing at all for whoever may not manage people (the API refuses the
 * list to them as well).
 */
export function EndedAccess({
  spaceId,
  spaceName,
  myRights,
  onChanged,
  onNotify,
}: {
  spaceId: string;
  spaceName: string;
  myRights: string[];
  /** The people changed (someone came back or was removed): read them again. */
  onChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
}) {
  const { t } = useTranslation();
  const allowed = canSeeEnded(myRights);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Ended[] | null>(null);
  const [reviving, setReviving] = useState<Ended | null>(null);
  const [removal, setRemoval] = useState<Removal>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await listEndedAccess(spaceId));
    } catch {
      setList((prev) => prev ?? []);
      onNotify({ tone: "danger", title: t("guests.endedLoadFailed") });
    }
  }, [spaceId, onNotify, t]);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    listEndedAccess(spaceId).then(
      (rows) => live && setList(rows),
      () => live && setList((prev) => prev ?? []),
    );
    return () => {
      live = false;
    };
  }, [allowed, spaceId]);

  if (!allowed || !list || list.length === 0) return null;

  const refresh = async () => {
    await Promise.all([onChanged(), load()]);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await confirmRemoval({ removeMember }, spaceId, removal, refresh);
      onNotify({ tone: "info", title: t("toast.memberRemoved"), description: removal?.name });
      setRemoval(null);
    } catch (err) {
      onNotify({ tone: "danger", title: t("toast.removeFailed"), description: refusalMessage(refusalOf(err), t, t("common.tryAgain"), "members") });
      // Whatever the list said, the server knows better now: a row that cannot be acted on goes away.
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={st.wrap} aria-labelledby="ended-title">
      <button type="button" style={st.toggle} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={16} />
        <span id="ended-title" style={st.title}>{t("guests.endedTitle")}</span>
        <span style={st.count}>{list.length}</span>
        {!open ? <span style={st.keep}>{t("guests.endedKeep")}</span> : null}
      </button>
      {open ? (
        <>
          <p style={st.note}>{t("guests.endedNote")}</p>
          {list.map((e) => (
            <EndedRow key={e.userId} item={e} onReactivate={() => setReviving(e)} onRemove={() => setRemoval(askRemoval(e))} />
          ))}
        </>
      ) : null}
      {reviving ? (
        <ReactivateDialog
          item={reviving}
          spaceId={spaceId}
          onClose={() => setReviving(null)}
          onDone={refresh}
          onFailed={load}
          onNotify={onNotify}
        />
      ) : null}
      {removal ? (
        <RemoveMemberDialog spaceName={spaceName} memberName={removal.name} busy={busy} onClose={() => setRemoval(null)} onConfirm={() => void remove()} />
      ) : null}
    </section>
  );
}

function EndedRow({ item, onReactivate, onRemove }: { item: Ended; onReactivate: () => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [now] = useState(() => new Date());
  return (
    <div style={st.row}>
      <Avatar name={item.name} src={getAvatar(item.name)} size={28} shape="round" />
      <span style={{ flex: 1, minWidth: 160 }}>
        <div style={st.name}>{item.name}</div>
        {item.title ? <div style={st.sub}>{item.title}</div> : null}
      </span>
      <span style={st.ended}>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>{t("guests.endedOn", { date: endLabel(item.endedAt, locale, displayZone()) })}</span>
        <span style={st.sub}>{keepLabel(item.endedAt, now, locale)}</span>
      </span>
      <Button size="sm" variant="secondary" iconLeft="refresh-cw" onClick={onReactivate}>
        {t("guests.reactivate")}
      </Button>
      <Button size="sm" variant="ghost" iconLeft="trash-2" onClick={onRemove} style={{ color: "var(--status-danger-fg)" }}>
        {t("guests.removeForGood")}
      </Button>
    </div>
  );
}

function ReactivateDialog({
  item,
  spaceId,
  onClose,
  onDone,
  onFailed,
  onNotify,
}: {
  item: Ended;
  spaceId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
  /** The reactivation was refused: read the list again. */
  onFailed: () => Promise<void>;
  onNotify: (toast: Toast) => void;
}) {
  const { t } = useTranslation();
  const zone = displayZone();
  const [now] = useState(() => new Date());
  const [choice, setChoice] = useState<EndChoice>("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await reactivateGuestAccess({ reactivateGuest }, { spaceId, userId: item.userId, choice, now: new Date(), zone }, onDone);
      onNotify({ tone: "success", title: t("guests.reactivated"), description: item.name });
      onClose();
    } catch (err) {
      setError(refusalMessage(refusalOf(err), t, t("guests.reactivateFailed"), "members"));
      setBusy(false);
      void onFailed();
    }
  };

  return (
    <Dialog
      title={t("guests.reactivateTitle", { name: item.name })}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" iconLeft="refresh-cw" disabled={busy || choiceRefusal(choice, now, zone) !== null} onClick={() => void go()}>
            {busy ? t("common.sending") : t("guests.reactivate")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <EndDateField choice={choice} onChange={setChoice} now={now} zone={zone} variant="reactivate" />
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: "var(--text-2xs)", color: "var(--text-muted)", lineHeight: "var(--leading-snug)" }}>
          <Icon name="info" size={13} style={{ flex: "none", marginTop: 1 }} />
          <span>{t("guests.reactivateNote")}</span>
        </div>
        {error ? (
          <p role="alert" style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--status-danger-fg)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
