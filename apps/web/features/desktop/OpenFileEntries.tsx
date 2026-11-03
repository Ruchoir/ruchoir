"use client";

import { useRef, useState } from "react";
import { Button, IconButton } from "@/components/ds";
import { fileDownloadUrl } from "@/lib/data/api";
import { openInWindow, openLocal } from "@/lib/desktop/files";
import { useTranslation } from "@/lib/i18n";
import { MenuPopover } from "../app/MenuPopover";
import { useDesktop } from "./DesktopContext";

/**
 * The desktop app's stand-in for "open in a new tab", which has no tab to open in: a small menu
 * offering the file in a window of its own, or in the computer's app for it. `href` is the address
 * the web build would have opened (the window shows it); the computer's app is given the file's
 * own download link instead, so the core can fetch it and, with `canVersion` (this person may
 * replace the file), watch the copy for a save to send as a new version.
 */
export function OpenFileEntries({
  href,
  name,
  fileId,
  canVersion = false,
  variant = "icon",
  size = "sm",
  iconVariant,
}: {
  href: string;
  name: string;
  /** The stored file; without it the computer's app is offered the file as a plain download. */
  fileId?: string;
  /** The server's rule for a new version: the file's owner or a space admin. */
  canVersion?: boolean;
  /** An icon button (a card, the lightbox) or a full-width labelled button (the viewer's side panel). */
  variant?: "icon" | "button";
  size?: "sm" | "md";
  /** The icon button's look, to match its neighbours. */
  iconVariant?: "ghost" | "outlined";
}) {
  const { t } = useTranslation();
  const instance = useDesktop()?.instanceId;
  const [open, setOpen] = useState(false);
  // The menu hangs from this box, whatever button is inside it.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const label = t("desktop.files.openMenu", { name });
  const toggle = () => setOpen((o) => !o);
  return (
    <span ref={anchorRef} style={{ display: variant === "button" ? "block" : "inline-flex", flex: "none" }}>
      {variant === "button" ? (
        <Button iconLeft="external-link" fullWidth title={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          {t("files.openAction")}
        </Button>
      ) : (
        <IconButton
          icon="external-link"
          label={label}
          size={size}
          variant={iconVariant}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        />
      )}
      <MenuPopover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        label={label}
        align="end"
        items={[
          { icon: "external-link", label: t("desktop.files.openWindow"), onClick: () => void openInWindow(href, name), testId: "open-window" },
          { icon: "monitor", label: t("desktop.files.openLocal"), onClick: () => void openLocal({ instance: instance ?? "", fileId, name, href: fileId ? fileDownloadUrl(fileId) : href, canVersion: canVersion && !!instance }), testId: "open-local" },
        ]}
      />
    </span>
  );
}
