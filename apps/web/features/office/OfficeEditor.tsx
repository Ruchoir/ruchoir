"use client";

import { useCallback, useEffect, useRef } from "react";
import { Avatar, Button, IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { useOfficeSession } from "./useOfficeSession";

export type OfficeEditorProps = {
  fileId: string;
  /** Convert a legacy format into an editable copy rather than opening it as it is. */
  convert?: boolean;
  /**
   * The address of a file open in the editor, for the address bar and "open in a new tab" (none: no
   * button). Asked again when a conversion moves the editor to its copy.
   */
  addressOf?: (fileId: string) => string;
  /** The editor cannot be reached right now: the caller shows the file another way (none: a note). */
  onUnavailable?: () => void;
  onClose: () => void;
};

/**
 * A document in the office editor, across the whole window: a Ruchoir band on top (the document,
 * who is editing it, a new tab, the way out), the engine below in a frame on its own hostname.
 *
 * The token is posted in a form, so it travels in a request body and never in an address. The
 * engine is a different origin from Ruchoir on purpose (see `docs/office-editing.md`): nothing here
 * reaches into the frame.
 */
export function OfficeEditor({ fileId, convert = false, addressOf, onUnavailable, onClose }: OfficeEditorProps) {
  const { t } = useTranslation();
  const { state, leave } = useOfficeSession(fileId, convert);
  // The file on screen: a conversion's copy once the engine has written it, the file asked otherwise.
  const shown = state.status === "ready" ? (state.copy ?? state.session.file) : null;
  const href = addressOf?.(shown?.id ?? fileId);
  const formRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameName = `office-${fileId}`;

  // The engine down: hand the file back to the caller once, rather than showing an error.
  const unavailable = state.status === "error" && state.reason === "unavailable";
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  });
  useEffect(() => {
    if (unavailable) onUnavailableRef.current?.();
  }, [unavailable]);

  // Post the token into the frame for each session: the first one, and the copy's after a conversion.
  const sessionToken = state.status === "ready" ? state.session.accessToken : null;
  useEffect(() => {
    if (sessionToken) formRef.current?.submit();
  }, [sessionToken]);

  // The latest `onClose`, so the parent handing a fresh function on each render (it re-renders on
  // every realtime event) neither re-runs the focus below nor re-binds the key listener.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // Closing says goodbye first and waits for it (see `useOfficeSession`'s `leave`), once.
  const closingRef = useRef(false);
  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    void leave().finally(() => onCloseRef.current());
  }, [leave]);
  const closeHandlerRef = useRef(close);
  useEffect(() => {
    closeHandlerRef.current = close;
  });

  // Focus the way out once, when the editor opens: never again, or a member typing in the document
  // would lose the keyboard whenever anything happened elsewhere in the app.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHandlerRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The address names the document while it is open, and goes back to what it was on close.
  useEffect(() => {
    if (!href || typeof window === "undefined") return;
    const before = `${window.location.pathname}${window.location.search}`;
    try {
      window.history.replaceState(null, "", href);
    } catch {
      // History unavailable (sandboxed frame, hardened browser): the editor works without it.
    }
    return () => {
      try {
        window.history.replaceState(null, "", before);
      } catch {
        // Same.
      }
    };
  }, [href]);

  const title = shown?.name ?? "";
  const origin = state.status === "ready" ? new URL(state.session.url).origin : "";
  const names = state.editors.map((e) => e.name).join(", ");

  return (
    <div className="wc-office" role="dialog" aria-modal="true" aria-label={title || t("office.editor")}>
      <div className="wc-office__head">
        <div className="wc-office__title" title={title}>
          {title}
        </div>
        {state.editors.length > 0 ? (
          <div className="wc-office__people" title={t("office.editingNow", { names })} aria-label={t("office.editingNow", { names })}>
            {state.editors.slice(0, 5).map((editor) => (
              <Avatar key={editor.id} name={editor.name} size={24} />
            ))}
          </div>
        ) : null}
        {href ? (
          <IconButton icon="external-link" label={t("image.openInNewTab", { name: title || t("office.editor") })} onClick={() => window.open(href, "_blank", "noopener")} />
        ) : null}
        <IconButton ref={closeRef} icon="x" label={t("common.close")} onClick={close} />
      </div>
      <div className="wc-office__body">
        {state.status === "ready" ? (
          <>
            <form ref={formRef} action={state.session.url} method="post" target={frameName} hidden>
              <input type="hidden" name="access_token" value={state.session.accessToken} />
              <input type="hidden" name="access_token_ttl" value={String(state.session.accessTokenTtl)} />
              <input type="hidden" name="docs_api_config" value={state.session.config} />
            </form>
            <iframe
              name={frameName}
              className="wc-office__frame"
              title={title}
              allow={`clipboard-read ${origin}; clipboard-write ${origin}; fullscreen ${origin}`}
              // Everything the editor needs, but never the right to navigate this tab: a page of the
              // engine (or a crafted document) could otherwise take the member out of Ruchoir.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
            />
          </>
        ) : state.status === "loading" ? (
          <div className="wc-office__note">{t("office.opening")}</div>
        ) : (
          <div className="wc-office__note">
            <strong>{t("office.failed")}</strong>
            <span>
              {state.reason === "forbidden"
                ? t("office.forbidden")
                : state.reason === "unsupported"
                  ? t("office.unsupported")
                  : `${t("office.unavailable")} ${t("common.tryAgain")}`}
            </span>
            <Button onClick={close}>{t("common.close")}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
