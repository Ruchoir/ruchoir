"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Button, Card, Dialog, Field, Icon, Tag, Textarea } from "@/components/ds";
import { deleteLicence, getLicence, putLicence, refusalOf } from "@/lib/data/api";
import type { LicenceView, SpaceEdition, SpaceLicence } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import { formatDate } from "@/lib/i18n/format";
import type { Toast } from "../app/types";
import { daysLeftBanner } from "./auditLogic";
import { refusalMessage } from "./MemberAccess";

const st: Record<string, CSSProperties> = {
  h: { fontSize: "clamp(28px, 3.4vw, 40px)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.05, color: "var(--text-strong)", marginBottom: 10 },
  sub: { fontSize: "var(--text-md)", color: "var(--text-body)", marginBottom: 20, lineHeight: "var(--leading-snug)" },
  sect: { fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", margin: "24px 0 10px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 18, marginTop: 14 },
  k: { display: "block", fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  v: { display: "block", fontSize: "var(--text-md)", fontWeight: 600, color: "var(--text-strong)", margin: "4px 0" },
  hint: { display: "block", fontSize: "var(--text-2xs)", color: "var(--text-muted)", lineHeight: "var(--leading-snug)" },
  bar: { display: "block", height: 6, borderRadius: "var(--radius-full)", background: "var(--surface-sunken)", overflow: "hidden", margin: "6px 0" },
  foot: { fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 14, lineHeight: "var(--leading-snug)", maxWidth: 560 },
  banner: { display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--radius-md)", marginBottom: 16, color: "var(--on-pastel)", fontSize: "var(--text-xs)" },
};

/** How every licence begins: shown as the field's example, the same in every language. */
const LICENCE_PREFIX = "RUCHOIR-LICENCE-1.";

export type LicenceSettingsProps = {
  spaceId: string;
  spaceName: string;
  edition: SpaceEdition;
  /** The space's licence as its list says, for the days left. */
  licence?: SpaceLicence;
  pricingUrl?: string;
  /** The edition changed: read the space again. */
  onChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
};

/** The Licence tab, for the space's owners: what is installed, and installing or removing one. */
export function LicenceSettings({ spaceId, spaceName, edition, licence, pricingUrl, onChanged, onNotify }: LicenceSettingsProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<LicenceView | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const banner = daysLeftBanner(licence, edition);

  useEffect(() => {
    let active = true;
    getLicence(spaceId)
      .then((found) => active && setView(found))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [spaceId, edition]);

  const install = async () => {
    setBusy(true);
    setError("");
    try {
      const installed = await putLicence(spaceId, text);
      setView(installed);
      setText("");
      await onChanged();
      onNotify({ tone: "success", title: t("licence.installed"), description: installed.organisation });
    } catch (err) {
      setError(refusalMessage(refusalOf(err), t, t("licence.installFailed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteLicence(spaceId);
      setConfirmRemove(false);
      setView(null);
      await onChanged();
      onNotify({ tone: "success", title: t("licence.removed") });
    } catch {
      setConfirmRemove(false);
      onNotify({ tone: "danger", title: t("licence.removeFailed"), description: t("space.retry") });
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    // A licence is a line of text; anything much bigger is not one.
    if (file.size > 64 * 1024) {
      setError(t("licence.refusal.invalid"));
      return;
    }
    setText((await file.text()).trim());
    setError("");
  };

  const share = view ? Math.min(100, Math.round((view.used / Math.max(1, view.seats)) * 100)) : 0;

  return (
    <>
      <h2 style={st.h}>{t("licence.title")}</h2>
      {view ? (
        <p style={st.sub}>{t("licence.sub")}</p>
      ) : (
        <p style={st.sub}>
          {t("licence.communitySubStrong")} {t("licence.communitySubRest")}
        </p>
      )}

      {banner ? (
        <div role="status" style={{ ...st.banner, background: banner.tone === "danger" ? "var(--peach)" : "var(--sun)" }}>
          <Icon name="clock" size={15} style={{ flex: "none", marginTop: 1 }} />
          <span>{t("licence.endsIn", { count: banner.days })}</span>
        </div>
      ) : null}

      {view ? (
        <Card padded>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            {view.edition === "frozen" ? (
              <Tag tone="warning" icon="clock">
                {t("licence.expiredTag")}
              </Tag>
            ) : (
              <Tag tone="success" icon="shield-check">
                {t("licence.enterprise")}
              </Tag>
            )}
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{view.organisation}</span>
          </div>
          <div style={st.grid}>
            <div>
              <span style={st.k}>{t("licence.seats")}</span>
              <span style={st.v}>{t("licence.seatsUsed", { used: view.used, count: view.seats })}</span>
              <span style={st.bar}>
                <span style={{ display: "block", height: "100%", width: `${share}%`, background: share >= 100 ? "var(--peach)" : "var(--mint)" }} />
              </span>
              <span style={st.hint}>{t("licence.guestsFree")}</span>
            </div>
            <div>
              <span style={st.k}>{t("licence.validUntil")}</span>
              <span style={st.v}>{formatDate(view.validUntil)}</span>
              <span style={st.hint}>{t("licence.reminders")}</span>
            </div>
            {view.installedAt ? (
              <div>
                <span style={st.k}>{t("licence.installedOn")}</span>
                <span style={st.v}>{formatDate(view.installedAt)}</span>
                {view.installedBy ? <span style={st.hint}>{t("licence.installedBy", { name: view.installedBy.name })}</span> : null}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {view ? <div style={st.sect}>{t("licence.replace")}</div> : null}
      <Field label={t("licence.pasteLabel")} htmlFor="licence-text" error={error || undefined}>
        <Textarea
          id="licence-text"
          rows={view ? 3 : 4}
          value={text}
          invalid={error !== ""}
          placeholder={LICENCE_PREFIX}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
        />
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 10 }}>
        <Button size="sm" variant="primary" iconLeft="key-round" disabled={busy || !text.trim()} onClick={() => void install()}>
          {busy ? t("common.sending") : t("licence.install")}
        </Button>
        <Button size="sm" variant="secondary" iconLeft="upload" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("licence.pickFile")}
        </Button>
        <input ref={fileRef} type="file" accept=".txt,.lic,.licence,text/plain" style={{ display: "none" }} onChange={(e) => void pickFile(e.target.files)} />
        <span style={{ flex: 1 }} />
        {view ? (
          <Button size="sm" variant="ghost" iconLeft="trash-2" disabled={busy} onClick={() => setConfirmRemove(true)}>
            {t("licence.remove")}
          </Button>
        ) : pricingUrl ? (
          <a className="wc-btn wc-btn--link wc-btn--sm" href={pricingUrl} target="_blank" rel="noreferrer">
            {t("roles.seePricing")}
            <Icon name="external-link" size={13} />
          </a>
        ) : null}
      </div>
      <p style={st.foot}>{t("licence.foot")}</p>

      <Dialog
        open={confirmRemove}
        title={t("licence.removeTitle", { space: spaceName })}
        onClose={() => setConfirmRemove(false)}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t("licence.remove")}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" }}>{t("licence.removeBody")}</p>
      </Dialog>
    </>
  );
}
