"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Avatar, Icon, IconButton, Input, Select } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import { deleteShare, listShares, putShare, type Share, type ShareLevel, shareCandidates } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";

const muted: CSSProperties = { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
const LEVELS: ShareLevel[] = ["freebusy", "read", "write"];

/**
 * Whom a personal calendar is shared with, and how far: each person with their level and a cross,
 * then a search among the people of the owner's spaces to add one. Every change is saved at once
 * and takes effect at once.
 */
export function SharesSection({ calendarId, onError }: { calendarId: string; onError: () => void }) {
  const { t } = useTranslation();
  const [shares, setShares] = useState<Share[] | null>(null);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<ShareLevel>("read");
  const [candidates, setCandidates] = useState<{ userId: string; name: string }[]>([]);
  // The caller hands a new function each time it draws: the list is read once per calendar.
  const failed = useRef(onError);
  useEffect(() => {
    failed.current = onError;
  }, [onError]);

  useEffect(() => {
    const controller = new AbortController();
    listShares(calendarId, controller.signal)
      .then(setShares)
      .catch(() => {
        if (!controller.signal.aborted) failed.current();
      });
    return () => controller.abort();
  }, [calendarId]);

  // The people matching what is typed, a quarter of a second after the last keystroke.
  const q = query.trim();
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!q) {
      setCandidates([]);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(() => {
      shareCandidates(calendarId, q, controller.signal)
        .then(setCandidates)
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [calendarId, q]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const levelOptions = LEVELS.map((l) => ({ value: l, label: t(`calendar.shareLevel.${l}`) }));
  const already = new Set((shares ?? []).map((s) => s.userId));

  const change = async (person: { userId: string; name: string }, next: ShareLevel) => {
    const before = shares;
    setShares((list) => {
      const rest = (list ?? []).filter((s) => s.userId !== person.userId);
      return [...rest, { ...person, level: next }].sort((a, b) => a.name.localeCompare(b.name));
    });
    try {
      await putShare(calendarId, person.userId, next);
    } catch {
      setShares(before);
      onError();
    }
  };
  const remove = async (share: Share) => {
    const before = shares;
    setShares((list) => (list ?? []).filter((s) => s.userId !== share.userId));
    try {
      await deleteShare(calendarId, share.userId);
    } catch {
      setShares(before);
      onError();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={muted}>{t("calendar.shareIntro")}</p>
      {shares && shares.length === 0 ? <p style={muted}>{t("calendar.shareNobody")}</p> : null}
      {(shares ?? []).map((share) => (
        <div key={share.userId} style={row}>
          <Avatar name={share.name} src={getAvatar(share.name)} size={24} />
          <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)", color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {share.name}
          </span>
          <div style={{ flex: "0 1 210px", minWidth: 0 }}>
            <Select
              size="sm"
              aria-label={t("calendar.shareLevelOf", { name: share.name })}
              value={share.level}
              onChange={(e) => void change(share, e.target.value as ShareLevel)}
              options={levelOptions}
              style={{ width: "100%" }}
            />
          </div>
          <IconButton icon="x" size="sm" label={t("calendar.shareRemove", { name: share.name })} onClick={() => void remove(share)} />
        </div>
      ))}
      <div style={{ ...row, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <Input
            size="sm"
            icon="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("calendar.shareSearch")}
            aria-label={t("calendar.shareSearch")}
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ flex: "0 1 210px", minWidth: 0 }}>
          <Select
            size="sm"
            aria-label={t("calendar.shareNewLevel")}
            value={level}
            onChange={(e) => setLevel(e.target.value as ShareLevel)}
            options={levelOptions}
            style={{ width: "100%" }}
          />
        </div>
      </div>
      {q && candidates.length === 0 ? <p style={muted}>{t("calendar.shareNoMatch")}</p> : null}
      {candidates.length > 0 ? (
        <div role="list" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {candidates.slice(0, 6).map((person) => (
            <button
              key={person.userId}
              type="button"
              className="wc-listrow"
              disabled={already.has(person.userId)}
              onClick={() => {
                void change(person, level);
                setQuery("");
              }}
              style={{ ...row, width: "100%", padding: "6px 8px", border: 0, borderRadius: "var(--radius-md)", background: "transparent", cursor: "pointer", textAlign: "left" }}
            >
              <Avatar name={person.name} src={getAvatar(person.name)} size={22} />
              <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)", color: "var(--text-strong)" }}>{person.name}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                <Icon name="user-plus" size={14} />
                {already.has(person.userId) ? t("calendar.shareAlready") : t(`calendar.shareLevel.${level}`)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
