"use client";

import { useEffect, useState } from "react";
import { Button, Card, Icon } from "@/components/ds";
import { getAudit } from "@/lib/data/api";
import { useTranslation } from "@/lib/i18n";
import { formatList } from "@/lib/i18n/format";
import { BANNER_DAYS, type Figure, importBanner, type ImportBanner as BannerView } from "./importLogic.ts";

/** One figure in words ("3 administrateurs"), the same words as the import's plan and done screens. */
export function figureText(t: ReturnType<typeof useTranslation>["t"], f: Figure): string {
  switch (f.kind) {
    case "administrators":
      return t("import.peopleAdminsTitle", { count: f.count });
    case "guests":
      return t("space.guests", { count: f.count });
    case "moderators":
      return t("import.peopleModsTitle", { count: f.count });
    case "groups":
      return t("import.peopleGroupsTitle", { count: f.count });
    case "customRoles":
      return t("members.importRoles", { count: f.count });
  }
}

/**
 * The line under the title of the Members page after an import: what came over and from where, with
 * a way to the journal. Read from the journal (the newest `import.applied` of the last week), so only
 * whoever holds `audit.view` sees it; it adds no route of its own.
 */
export function ImportBanner({ spaceId, rights, onOpenJournal }: { spaceId: string; rights: string[]; onOpenJournal?: () => void }) {
  const { t } = useTranslation();
  const [banner, setBanner] = useState<BannerView | null>(null);
  const canRead = rights.includes("audit.view");
  useEffect(() => {
    if (!canRead) return;
    let alive = true;
    const since = new Date(Date.now() - BANNER_DAYS * 86_400_000).toISOString();
    getAudit(spaceId, { category: "members", since, limit: 50 })
      .then((page) => {
        if (alive) setBanner(importBanner(page.entries, new Date(), ["audit.view"]));
      })
      .catch(() => {
        // A banner is a courtesy: when the journal cannot be read, the page simply has none.
      });
    return () => {
      alive = false;
    };
  }, [spaceId, canRead]);
  if (!banner) return null;
  const when =
    banner.when.kind === "today" ? t("members.importWhenToday") : banner.when.kind === "yesterday" ? t("members.importWhenYesterday") : t("members.importWhenDays", { count: banner.when.days });
  return (
    <Card style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", marginBottom: 14 }}>
      <Icon name="import" size={16} style={{ flex: "none", color: "var(--text-muted)" }} />
      <p style={{ flex: 1, minWidth: 0, margin: 0, fontSize: "var(--text-xs)", lineHeight: "var(--leading-snug)", color: "var(--text-body)" }}>
        <b style={{ color: "var(--text-strong)" }}>{t("members.importBannerTitle", { source: banner.source, when })}</b>{" "}
        {banner.figures.length > 0 ? t("members.importBannerText", { figures: formatList(banner.figures.map((f) => figureText(t, f))), source: banner.source }) : null}
      </p>
      {onOpenJournal ? (
        <Button size="sm" variant="ghost" onClick={onOpenJournal}>
          {t("members.importBannerLink")}
        </Button>
      ) : null}
    </Card>
  );
}
