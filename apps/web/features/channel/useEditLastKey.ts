"use client";

import type { KeyboardEvent, RefObject } from "react";
import { useSettings } from "../app/settings";
import { eventToChord } from "../app/shortcuts";
import type { MessageEditorHandle } from "./MessageEditor";

/**
 * The key handler behind "edit my last message" (ArrowUp by default, rebindable in the preferences).
 *
 * Put on an element around a composer's editor, it opens the last message one wrote when the bound
 * chord is pressed in an empty editor. It stands aside in every other case, so the key keeps its
 * usual job:
 * - text is written (spaces and blank lines alone count as empty), or `blocked` is set: an edit
 *   already open, files waiting to be sent with a new message;
 * - the editor's own handler took the key (`defaultPrevented`): the `@`/`#`/emoji suggestions walk
 *   their list with the arrows;
 * - the key came from somewhere else in the composer (the toolbar, the emoji picker's search);
 * - an input method is composing a character;
 * - nobody passed `onEditLast`, or the shortcut is unbound.
 *
 * `onEditLast` answers whether it found a message to open: the key is only taken when it did.
 */
export function useEditLastKey(
  editorRef: RefObject<MessageEditorHandle | null>,
  blocked: boolean,
  onEditLast: (() => boolean) | undefined,
) {
  const chord = useSettings().shortcuts.editLast;
  return (e: KeyboardEvent<HTMLElement>) => {
    if (!onEditLast || !chord || blocked || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (!(e.target instanceof HTMLElement) || !e.target.isContentEditable) return;
    if (eventToChord(e.nativeEvent) !== chord) return;
    if (!editorRef.current?.isEmpty()) return;
    if (onEditLast()) e.preventDefault();
  };
}
