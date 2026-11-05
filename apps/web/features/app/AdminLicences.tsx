"use client";

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { licenceRows, type AdminLicence } from "@ruchoir/client/permissionsLogic";
import { Tag } from "@/components/ds";
import { getAdminLicences } from "@/lib/data/api";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { formatDate } from "@/lib/i18n/format";
import { displayZone, endLabel } from "@/features/settings/guestLogic.ts";

/**
 * The licences of the instance, for its administrator: one line per space, the soonest end first.
 * Read only: each space's owner installs and removes their own licence from the space's settings.
 */
const st: Record<string, CSSProperties> = {
  sub: { fontSize: "var(--text-xs)", color: "var(--text-muted)", margin: "0 0 18px", maxWidth: 560, lineHeight: 1.5 },
  empty: { fontSize: "var(--text-xs)", color: "var(--text-muted)", padding: "12px 0" },
  wrap: { border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", overflowX: "auto", background: "var(--surface-card)" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: 560 },
  th: {
    fontFamily: "var(--label-font)",
    height: 36,
    textAlign: "left",
    fontSize: "var(--text-2xs)",
    fontWeight: 500,
    color: "var(--text-muted)",
    padding: "0 12px",
    background: "var(--surface-canvas)",
    borderBottom: "1.5px solid var(--border-subtle)",
  },
  td: { padding: "10px 12px", fontSize: "var(--text-xs)", color: "var(--text-body)", borderBottom: "1px solid var(--border-subtle)", verticalAlign: "top" },
};

const STATUS: Record<Exclude<NonNullable<AdminLicence["status"]>, "invalid">, TranslationKey> = {
  active: key("licence.tag.active"),
  suspended: key("licence.tag.suspended"),
  revoked: key("licence.tag.revoked"),
  unreachable: key("licence.tag.unreachable"),
  no_status: key("licence.tag.noStatus"),
  expired: key("admin.licenceFrozen"),
  not_yet: key("licence.tag.notYet"),
  clock: key("licence.tag.clock"),
};

const EDITION: Record<AdminLicence["edition"], TranslationKey> = {
  enterprise: key("licence.enterprise"),
  frozen: key("admin.licenceFrozen"),
  community: key("admin.licenceCommunity"),
  invalid: key("admin.licenceUnreadable"),
};

export function AdminLicences() {
  const { t } = useTranslation();
  const [list, setList] = useState<AdminLicence[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getAdminLicences()
      .then((rows) => active && setList(rows))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const now = new Date();
  const zone = displayZone();
  const rows = useMemo(() => (list ? licenceRows(list, new Date(), displayZone()) : null), [list]);
  const locale = currentLocale();

  return (
    <>
      <p style={st.sub}>{t("admin.licencesIntro")}</p>
      {failed ? (
        <p role="alert" style={{ ...st.empty, color: "var(--status-danger-fg)" }}>
          {t("admin.licencesLoadFailed")}
        </p>
      ) : rows === null ? (
        <p style={st.empty}>{t("admin.loading")}</p>
      ) : rows.length === 0 ? (
        <p style={st.empty}>{t("admin.licencesEmpty")}</p>
      ) : (
        <div style={st.wrap}>
          <table style={st.table}>
            <thead>
              <tr>
                <th style={st.th}>{t("sidebar.space")}</th>
                <th style={st.th}>{t("admin.licenceColHolder")}</th>
                <th style={st.th}>{t("admin.licenceColEdition")}</th>
                <th style={st.th}>{t("licence.seats")}</th>
                <th style={st.th}>{t("admin.licenceColEnd")}</th>
                <th style={st.th}>{t("admin.licenceColMode")}</th>
                <th style={st.th}>{t("admin.licenceColStatus")}</th>
                <th style={st.th}>{t("admin.licenceColCheck")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.spaceId}>
                  <td style={{ ...st.td, fontWeight: 500, color: "var(--text-strong)" }}>{r.spaceName}</td>
                  <td style={st.td}>{r.organisation}</td>
                  <td style={st.td}>
                    <Tag tone={r.frozen || r.edition === "invalid" ? "danger" : r.soon ? "warning" : "neutral"}>{t(EDITION[r.edition])}</Tag>
                  </td>
                  <td style={st.td}>{t("admin.licenceSeats", { used: r.used, count: r.seats })}</td>
                  <td style={st.td}>
                    {r.unreadable
                      ? t("admin.licenceUnreadable")
                      : r.frozen
                        ? t("admin.licenceExpiredOn", { date: endLabel(r.validUntil, locale, zone, now) })
                        : endLabel(r.validUntil, locale, zone, now)}
                    {r.frozen || r.unreadable ? null : (
                      <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{r.daysLeft === 0 ? t("admin.licenceLastDay") : t("admin.licenceDaysLeft", { count: r.daysLeft })}</div>
                    )}
                  </td>
                  <td style={st.td}>{r.mode ? t(r.mode === "online" ? "licence.mode.online" : "licence.mode.offline") : null}</td>
                  <td style={st.td}>{r.status && r.status !== "invalid" ? <Tag tone={r.status === "active" ? "neutral" : "warning"}>{t(STATUS[r.status])}</Tag> : null}</td>
                  <td style={st.td}>{r.mode === "online" ? (r.lastCheckInAt ? formatDate(r.lastCheckInAt) : t("licence.checkNever")) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
