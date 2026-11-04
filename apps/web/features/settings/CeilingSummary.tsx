"use client";

import { useState } from "react";
import { Button, Dialog, Icon, Switch, Tag } from "@/components/ds";
import { refusalOf, updateRole } from "@/lib/data/api";
import type { Role } from "@/lib/data/types";
import { key, useTranslation, type TranslationKey } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { CEILING_SENTENCES, GUEST_TUNABLE, guestRightsAfter, type CeilingSentence } from "./guestCeiling.ts";
import { refusalMessage } from "./roleChips";

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
        <Icon name="sparkles" size={16} style={{ flex: "none", color: "var(--text-muted)" }} />
        <span style={{ flex: 1 }}>
          <strong style={{ fontWeight: 700, color: "var(--text-strong)" }}>{t("guests.rightsUpsellLead")}</strong> {t("guests.rightsUpsellRest")}
        </span>
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

const RIGHT_TEXT: Record<(typeof GUEST_TUNABLE)[number], TranslationKey> = {
  "message.send": key("guests.rightWrite"),
  "message.react": key("message.react"),
  "message.attach": key("perm.messageAttach"),
  "dm.start": key("guests.rightDm"),
  "message.pin": key("guests.rightPin"),
  "message.mention_all": key("guests.rightMention"),
};

/**
 * "Droits des invités" with a licence: the tunable rights of the guests' role as switches, over the
 * ceiling that nothing lifts. Saves through the role editor's own call (`updateRole`).
 */
export function GuestRightsEditorDialog({
  spaceId,
  role,
  myRights,
  onChanged,
  onNotify,
  onClose,
}: {
  spaceId: string;
  role: Role;
  /** What the viewer holds: they give and take only that (rule 2). */
  myRights: string[];
  onChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Set<string>>(() => new Set(role.permissions));
  const [busy, setBusy] = useState(false);
  const editable = role.manageable;
  const changed = GUEST_TUNABLE.some((p) => draft.has(p) !== role.permissions.includes(p));
  const line = { margin: "2px 0 0", fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-snug)" };
  const head = { margin: "14px 0 0", fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text-strong)" };
  const save = async () => {
    setBusy(true);
    try {
      await updateRole(spaceId, role.id, { permissions: guestRightsAfter(role.permissions, draft) });
      await onChanged();
      onNotify({ tone: "success", title: t("roles.saved"), description: t("guests.rights") });
      onClose();
    } catch (err) {
      onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {t("guests.rights")}
          <Tag tone="info" icon="sparkles">
            {t("guests.rightsEnterprise")}
          </Tag>
        </span>
      }
      closeLabel={t("common.close")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          {editable ? (
            <Button iconLeft="check" disabled={!changed || busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          ) : null}
        </>
      }
    >
      <p style={{ ...line, marginTop: 0, marginBottom: 14 }}>{t("guests.rightsEditorSub")}</p>
      <p style={{ ...head, margin: "0 0 8px" }}>{t("guests.rightsToggleTitle")}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: "0 14px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-card)" }}>
        {GUEST_TUNABLE.map((permission, i) => (
          <li key={permission} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: i ? "1px solid var(--border-subtle)" : "none", fontSize: "var(--text-sm)", color: "var(--text-strong)" }}>
            <span style={{ flex: 1 }}>{t(RIGHT_TEXT[permission])}</span>
            <Switch
              aria-label={t(RIGHT_TEXT[permission])}
              checked={draft.has(permission)}
              disabled={!editable || busy || !myRights.includes(permission)}
              onChange={(e) =>
                setDraft((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(permission);
                  else next.delete(permission);
                  return next;
                })
              }
            />
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 16 }}>
        <CeilingSummary />
      </div>
      <p style={head}>{t("guests.rightsOpens")}</p>
      <p style={line}>{t("guests.rightsOpensBody")}</p>
    </Dialog>
  );
}
