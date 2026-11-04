"use client";

import { Button, Dialog, Icon, Tag } from "@/components/ds";
import { key, useTranslation, type TranslationKey } from "@/lib/i18n";
import { CEILING_SENTENCES, type CeilingSentence } from "./guestCeiling.ts";

const SENTENCE: Record<CeilingSentence["id"], TranslationKey> = {
  directory: key("guests.ceilingDirectory"),
  people: key("guests.ceilingPeople"),
  create: key("guests.ceilingCreate"),
  moderate: key("guests.ceilingModerate"),
  settings: key("guests.ceilingSettings"),
};

/** "Un invité ne peut jamais": what no setting gives a guest, one plain sentence each. */
export function CeilingSummary() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="ceiling-title">
      <h4 id="ceiling-title" style={{ margin: "0 0 8px", fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-strong)" }}>
        {t("guests.ceilingTitle")}
      </h4>
      <ul style={{ listStyle: "none", margin: 0, padding: "4px 12px", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-card)" }}>
        {CEILING_SENTENCES.map((s, i) => (
          <li key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: i ? "1px solid var(--border-subtle)" : "none", fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
            <Icon name="x" size={14} style={{ flex: "none", color: "var(--status-danger-fg)" }} />
            {t(SENTENCE[s.id])}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The guests' rights as a community space reads them: the ceiling, how a guest reaches things, and what
 * they can do there. Changing it is the paid edition's, which the last line says.
 */
export function GuestRightsDialog({ spaceName, pricingUrl, onClose }: { spaceName: string; pricingUrl?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const line = { margin: "2px 0 0", fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-snug)" };
  const head = { margin: "14px 0 0", fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text-strong)" };
  return (
    <Dialog
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {t("guests.rights")}
          <Tag>{t("guests.rightsFree")}</Tag>
        </span>
      }
      closeLabel={t("common.close")}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      <p style={{ ...line, marginTop: 0, marginBottom: 14 }}>{t("guests.rightsSub", { space: spaceName })}</p>
      <CeilingSummary />
      <p style={head}>{t("guests.rightsOpens")}</p>
      <p style={line}>{t("guests.rightsOpensBody")}</p>
      <p style={head}>{t("guests.rightsCan")}</p>
      <p style={line}>{t("guests.rightsCanBody")}</p>
      <div style={{ marginTop: 14, padding: "10px 12px", border: "1px dashed var(--border-default)", borderRadius: "var(--radius-card)", display: "flex", gap: 10, alignItems: "center", fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
        <span style={{ flex: 1 }}>{t("guests.rightsUpsell")}</span>
        {pricingUrl ? (
          <a className="wc-btn wc-btn--link wc-btn--sm" href={pricingUrl} target="_blank" rel="noreferrer">
            {t("roles.seePricing")}
            <Icon name="external-link" size={13} />
          </a>
        ) : null}
      </div>
    </Dialog>
  );
}
