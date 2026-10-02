"use client";

import { Avatar } from "@/components/ds";
import type { FileEditor } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";

/** Who is editing a file right now: their faces, named in the tooltip. Nothing when nobody is. */
export function EditingBadge({ editors, size = 18 }: { editors?: FileEditor[]; size?: number }) {
  const { t } = useTranslation();
  if (!editors || editors.length === 0) return null;
  const label = t("office.editingNow", { names: editors.map((e) => e.name).join(", ") });
  return (
    <span title={label} aria-label={label} style={{ display: "inline-flex", gap: 2, flex: "none" }}>
      {editors.slice(0, 3).map((editor) => (
        <Avatar key={editor.id} name={editor.name} size={size} />
      ))}
    </span>
  );
}
