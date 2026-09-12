"use client";

import { useRef, useState } from "react";
import { Icon, IconButton, Popover } from "@/components/ds";
import { EmojiPicker } from "./EmojiPicker";
import { useTranslation } from "@/lib/i18n";

export type ReactionMenuProps = {
  onPick: (emoji: string) => void;
  variant?: "pill" | "action";
  /** Notified when the picker opens/closes, so a hover-gated container can stay mounted. */
  onOpenChange?: (open: boolean) => void;
};

/** A trigger that opens the emoji picker in a viewport-aware popover. */
export function ReactionMenu({ onPick, variant = "action", onOpenChange }: ReactionMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const set = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const pick = (emoji: string) => {
    onPick(emoji);
    set(false);
  };

  return (
    <>
      {variant === "pill" ? (
        <button
          ref={anchorRef}
          type="button"
          aria-label={t("message.addReaction")}
          aria-expanded={open}
          onClick={() => set(!open)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 26,
            padding: "0 9px",
            border: "1px solid var(--border-default)",
            background: open ? "var(--surface-active)" : "var(--surface-canvas)",
            borderRadius: "var(--radius-full)",
            color: "var(--text-subtle)",
            cursor: "pointer",
          }}
        >
          <Icon name="smile-plus" size={14} />
        </button>
      ) : (
        <IconButton
          ref={anchorRef}
          icon="smile-plus"
          label={t("message.react")}
          size="sm"
          aria-expanded={open}
          onClick={() => set(!open)}
        />
      )}

      <Popover anchorRef={anchorRef} open={open} onClose={() => set(false)} placement="top" align="start">
        <EmojiPicker onPick={pick} animated />
      </Popover>
    </>
  );
}
