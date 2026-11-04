"use client";

import { Icon } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { browserZone, endLabel, guestBanner } from "@/features/settings/guestLogic.ts";

/** A thin line under the space's name that reminds a guest where they are, and until when. */
export function GuestBanner({ role, spaceName, expiresAt }: { role: string; spaceName: string; expiresAt?: string }) {
  const { t } = useTranslation();
  const banner = guestBanner(role, expiresAt);
  if (!banner) return null;
  return (
    <div
      role="note"
      style={{
        margin: "8px 8px 0", padding: "8px 10px", display: "flex", gap: 8, alignItems: "flex-start", borderRadius: "var(--radius-item)",
        background: "var(--status-warning-bg)", border: "1px solid var(--status-warning-border)", color: "var(--status-warning-fg)",
        fontSize: "var(--text-xs)", fontWeight: 600, lineHeight: "var(--leading-snug)",
      }}
    >
      <Icon name="user" size={14} style={{ flex: "none", marginTop: 1 }} />
      <span>
        {banner.dated
          ? t("guests.bannerUntil", { space: spaceName, date: endLabel(banner.until, currentLocale(), browserZone(), new Date()) })
          : t("guests.bannerNoEnd", { space: spaceName })}
      </span>
    </div>
  );
}
