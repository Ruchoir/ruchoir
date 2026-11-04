"use client";

import { Button, Dialog, Icon } from "@/components/ds";
import type { UsedIn } from "@/lib/data/types";
import { key, useTranslation } from "@/lib/i18n";
import { tk } from "../access/EntryRow";
import { usedInRows } from "./usedInLogic.ts";

const ICON = { channel: "hash", file: "file", calendar: "calendar" } as const;

/**
 * Why a group or a role cannot be deleted (frame 15): rules still name it, and removing the name
 * could lift a refusal without anyone seeing it. Lists where, with the places the viewer cannot open
 * last and unnamed.
 */
export function UsedInDialog({ of, name, usedIn, onClose }: { of: "group" | "role"; name: string; usedIn: UsedIn[]; onClose: () => void }) {
  const { t } = useTranslation();
  const rows = usedInRows(usedIn);
  return (
    <Dialog
      open
      title={t(of === "group" ? key("access.usedIn.titleGroup") : key("access.usedIn.titleRole"), { name })}
      subtitle={t("access.usedIn.sub")}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p
          role="alert"
          style={{ margin: 0, display: "flex", gap: 8, padding: "10px 12px", background: "var(--status-warning-bg)", border: "1px solid var(--status-warning-border)", borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: 1.5 }}
        >
          <Icon name="alert-triangle" size={15} style={{ color: "var(--status-warning-fg)", flex: "none", marginTop: 1 }} />
          <span>
            <strong>{t("access.usedIn.warnTitle", { name })}</strong> {t("access.usedIn.warnBody")}
          </span>
        </p>
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          <div style={{ padding: "8px 14px", background: "var(--surface-sunken)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("access.usedIn.where")}</div>
          {rows.map((row, i) => (
            <div key={`${row.kind}:${row.id ?? i}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderTop: "1px solid var(--border-subtle)" }}>
              <span aria-hidden style={{ width: 32, height: 32, flex: "none", borderRadius: "var(--radius-md)", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-body)" }}>
                <Icon name={ICON[row.kind]} size={16} />
              </span>
              <span>
                <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{row.hidden ? t("access.usedIn.hidden") : row.label}</div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t(tk(row.kindKey))}</div>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
