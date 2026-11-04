import { refusalOf, startPreview } from "@/lib/data/api";
import type { Role } from "@/lib/data/types";
import type { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { refusalMessage } from "./roleChips";

/** Looks at the space as `role`: the server starts a read-only session, and the app reloads under it. */
export async function startViewAs(spaceId: string, role: Pick<Role, "id">, onNotify: (toast: Toast) => void, t: ReturnType<typeof useTranslation>["t"]): Promise<void> {
  try {
    await startPreview(spaceId, role.id);
    window.location.reload();
  } catch (err) {
    onNotify({ tone: "danger", title: t("preview.startFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
  }
}
