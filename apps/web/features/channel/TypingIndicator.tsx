/**
 * "Someone is typing" indicator. Ephemeral: the realtime layer delivers this over the channel and
 * never stores it. Rendered just above the composer.
 */

import { useTranslation } from "@/lib/i18n";

export function TypingIndicator({ names }: { names: string[] }) {
  const { t } = useTranslation();
  if (names.length === 0) return null;
  const label =
    names.length === 1
      ? t("conversation.typingOne", { name: names[0] })
      : t("conversation.typingMany", {
          names: names.slice(0, 2).join(", "),
          count: names.length,
        });
  return (
    <div
      aria-live="polite"
      style={{
        maxWidth: "var(--channel-measure)",
        width: "100%",
        margin: "0 auto",
        padding: "4px 24px 8px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 20,
        fontSize: 12,
        fontStyle: "italic",
        color: "var(--text-subtle)",
      }}
    >
      <span className="wc-typing" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label}
    </div>
  );
}
