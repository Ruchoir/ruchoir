"use client";

import { useState } from "react";
import { Icon, Sheet, SheetGroup, SheetItem } from "@/components/ds";
import { QUICK_REACTIONS } from "@/lib/emoji";
import { useTranslation } from "@/lib/i18n";
import { Emoji } from "../app/Emoji";
import { EmojiPicker } from "./EmojiPicker";

/**
 * A message's actions on a touch screen, opened by pressing and holding the message: a row of quick
 * reactions, then everything the desktop spreads between its hover toolbar and its "more" menu, in
 * one list with the destructive entry set apart. The same entries, under the same rules (own
 * message, pin rights, thread or not), as the desktop's; only the gesture and the shape change.
 */
export type MessageActionSheetProps = {
  open: boolean;
  onClose: () => void;
  /** When it was sent, already in the reader's language: said at the top, as the desktop menu does. */
  sentAt: string;
  own: boolean;
  saved?: boolean;
  pinned?: boolean;
  canPin: boolean;
  /** Inside a thread there is no thread to open and no feed position to mark unread from. */
  inThread: boolean;
  hasReactions: boolean;
  onReact: (emoji: string) => void;
  onOpenThread: () => void;
  onToggleSave: () => void;
  onEdit: () => void;
  onCopyMessage: () => void;
  onCopyLink: () => void;
  onTogglePin: () => void;
  onMarkUnread: () => void;
  onShowReactions: () => void;
  onDelete: () => void;
};

export function MessageActionSheet(p: MessageActionSheetProps) {
  const { t } = useTranslation();
  // The full picker replaces the list when the six quick ones are not the one wanted.
  const [picking, setPicking] = useState(false);
  const close = () => {
    setPicking(false);
    p.onClose();
  };
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <Sheet open={p.open} label={t("message.more")} onClose={close}>
      {picking ? (
        <div style={{ display: "flex", justifyContent: "center", paddingBottom: 8 }}>
          <EmojiPicker onPick={(emoji) => run(() => p.onReact(emoji))()} />
        </div>
      ) : (
        <>
          <div style={{ padding: "0 6px 10px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)" }}>{p.sentAt}</div>
          <div className="wc-sheet__reacts">
            {QUICK_REACTIONS.slice(0, 6).map((emoji) => (
              <button key={emoji} type="button" className="wc-sheet__react" aria-label={emoji} onClick={run(() => p.onReact(emoji))}>
                <Emoji emoji={emoji} size={24} />
              </button>
            ))}
            <button type="button" className="wc-sheet__react" aria-label={t("composer.emoji")} onClick={() => setPicking(true)}>
              <Icon name="smile-plus" size={22} />
            </button>
          </div>
          <SheetGroup>
            {p.inThread ? null : <SheetItem icon="message-square" label={t("message.replyInThread")} onClick={run(p.onOpenThread)} />}
            <SheetItem icon="bookmark" label={p.saved ? t("message.unsave") : t("message.save")} onClick={run(p.onToggleSave)} />
            <SheetItem icon="copy" label={t("message.copyMessage")} onClick={run(p.onCopyMessage)} />
            <SheetItem icon="paperclip" label={t("message.copyLink")} onClick={run(p.onCopyLink)} />
            {p.inThread ? null : <SheetItem icon="inbox" label={t("message.markUnread")} onClick={run(p.onMarkUnread)} />}
            {p.canPin ? <SheetItem icon="pin" label={p.pinned ? t("message.unpin") : t("message.pin")} onClick={run(p.onTogglePin)} /> : null}
            {p.hasReactions ? <SheetItem icon="smile" label={t("message.viewReactions")} onClick={run(p.onShowReactions)} /> : null}
            {p.own ? <SheetItem icon="square-pen" label={t("message.editMessage")} onClick={run(p.onEdit)} /> : null}
          </SheetGroup>
          {p.own ? (
            <SheetGroup>
              <SheetItem icon="trash-2" label={t("message.deleteMessage")} danger onClick={run(p.onDelete)} />
            </SheetGroup>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
