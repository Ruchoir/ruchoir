"use client";

import { useState } from "react";
import { Button, Dialog, Icon, Tag } from "@/components/ds";
import { refusalOf, setAccessRule } from "@/lib/data/api";
import type { AccessEntry, AccessKind, AccessView } from "@/lib/data/types";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { formatList } from "@/lib/i18n/format";
import { PERMISSION_TEXT } from "../settings/permissionText";
import { shouldToastRefusal } from "../app/previewLogic.ts";
import { refusalMessage } from "../settings/roleChips";
import { levelLabelKey } from "./accessLogic.ts";
import { changedCount, nextRadio, draftOf, groupsOf, locksOf, resultOf, ruleOf, setState, stateOf, type State } from "./customiseLogic.ts";
import { tk } from "./EntryRow";

const STATES = ["inherited", "allow", "deny"] as const;
const GROUP_LABEL: Record<"read" | "participate" | "manage", TranslationKey> = {
  read: key("customise.groupRead"),
  participate: key("customise.groupParticipate"),
  manage: key("profile.tabManage"),
};
const STATE_LABEL: Record<State, TranslationKey> = {
  inherited: key("customise.inherited"),
  allow: key("customise.allowed"),
  deny: key("customise.denied"),
};

/**
 * One entry, permission by permission (frame 5): Hérité, Autorisé or Refusé each. What the editor
 * does not hold is locked with the reason; the result line says the nearest level and its
 * differences. Saving writes the entry's rule, and clearing everything removes it.
 */
export function CustomiseDialog({
  spaceId,
  kind,
  resourceId,
  entry,
  entryName,
  where,
  access,
  onClose,
  onSaved,
  onNotify,
  pricingUrl,
}: {
  spaceId: string;
  kind: AccessKind;
  resourceId: string;
  entry: AccessEntry;
  entryName: string;
  /** Where the entry sits, as a person says it (`#compta`, a folder, a calendar). */
  where: string;
  access: AccessView;
  onClose: () => void;
  onSaved: (view: AccessView) => void;
  onNotify: (toast: { tone: "danger" | "success" | "info"; title: string; description?: string }) => void;
  pricingUrl?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => draftOf(entry));
  const [busy, setBusy] = useState(false);
  const locks = locksOf(kind, access.may.held, entry.guest);
  const changed = changedCount(entry, draft);
  const result = resultOf(kind, entry.summary?.nearest ?? entry.level, draft);
  const name = (permission: string) => {
    const text = PERMISSION_TEXT[permission];
    return text ? t(text.title) : permission;
  };

  const save = async () => {
    setBusy(true);
    try {
      onSaved(await setAccessRule(spaceId, kind, resourceId, { kind: entry.target.kind, id: entry.target.id }, ruleOf(kind, draft)));
      onClose();
    } catch (err) {
      if (shouldToastRefusal(refusalOf(err))) onNotify({ tone: "danger", title: t("customise.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {t("customise.title", { name: entryName })}
          <Tag tone="info" icon="sparkles">
            {t("access.enterprise")}
          </Tag>
        </span>
      }
      subtitle={`${where}. ${t("customise.subtitle")}`}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <>
          <span style={{ marginRight: "auto", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
            {changed === 0 ? t("customise.unchanged") : t("customise.changed", { count: changed })}
          </span>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || changed === 0 || !access.may.fine} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          {groupsOf(kind).map((g) => (
            <div key={g.group}>
              <div style={{ padding: "8px 14px", background: "var(--surface-sunken)", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-strong)" }}>
                {t(GROUP_LABEL[g.group])}
              </div>
              {g.permissions.map((permission) => {
                const text = PERMISSION_TEXT[permission];
                const state = stateOf(draft, permission);
                const lock = locks[permission];
                const edited = state !== stateOf(draftOf(entry), permission);
                return (
                  <div
                    key={permission}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 14px",
                      borderTop: "1px solid var(--border-subtle)",
                      background: edited ? "var(--status-info-bg)" : undefined,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{name(permission)}</span>
                        {lock ? <Icon name="lock" size={13} aria-hidden style={{ color: "var(--text-muted)" }} /> : null}
                        {edited ? <Tag tone="info">{t("files.modified")}</Tag> : null}
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                        {lock ? t(lock === "guest" ? (key("access.guestCap")) : (key("customise.lockNotHeld"))) : text ? t(text.desc) : null}
                      </div>
                    </div>
                    <div role="radiogroup" aria-label={name(permission)} style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", overflow: "hidden", flex: "none" }}>
                      {STATES.map((option, optionIndex) => {
                        const active = state === option;
                        return (
                          <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            // Roving tabindex: the group is one stop, arrows move inside it.
                            tabIndex={active ? 0 : -1}
                            onKeyDown={(e) => {
                              const next = nextRadio(e.key, optionIndex, STATES.length);
                              if (next === undefined) return;
                              e.preventDefault();
                              setDraft((d) => setState(d, permission, STATES[next]));
                              (e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next])?.focus();
                            }}
                            disabled={lock !== undefined || busy}
                            onClick={() => setDraft((d) => setState(d, permission, option))}
                            style={{
                              border: 0,
                              borderLeft: option === "inherited" ? 0 : "1px solid var(--border-subtle)",
                              padding: "5px 12px",
                              font: "inherit",
                              fontSize: "var(--text-xs)",
                              fontWeight: active ? 700 : 500,
                              cursor: lock ? "default" : "pointer",
                              opacity: lock ? 0.5 : 1,
                              background: active ? (option === "allow" ? "var(--status-success-bg)" : option === "deny" ? "var(--status-danger-bg)" : "var(--surface-sunken)") : "var(--surface-raised)",
                              color: active ? (option === "allow" ? "var(--status-success-fg)" : option === "deny" ? "var(--status-danger-fg)" : "var(--text-strong)") : "var(--text-muted)",
                            }}
                          >
                            {t(STATE_LABEL[option])}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <p role="status" style={{ margin: 0, display: "flex", gap: 8, padding: "10px 12px", border: "1px solid var(--status-info-border)", background: "var(--status-info-bg)", borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: 1.5 }}>
          <Icon name="info" size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>
            <strong>
              {t("customise.resultLevel", { level: t(tk(levelLabelKey(kind, result.level))) })}
              {result.except.length > 0 ? t("customise.resultExcept", { list: formatList(result.except.map(name)) }) : ""}
              {result.plus.length > 0 ? t("customise.resultPlus", { list: formatList(result.plus.map(name)) }) : ""}.
            </strong>{" "}
            {t("customise.resultNote")}
          </span>
        </p>

        {!access.may.fine ? (
          <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
            <Icon name="sparkles" size={14} />
            {t("customise.upsell")}{" "}
            {pricingUrl ? (
              <a href={pricingUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: "var(--text-strong)" }}>
                {t("roles.seePricing")}
              </a>
            ) : null}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
