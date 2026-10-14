/**
 * The event form's draft, kept outside the form so its sheets can read and change it: the calendar
 * sheet, the date and time pickers, the repetition, the people... are screens of their own, as every
 * sheet of the app is, and the form is still mounted under them. Each form names its draft with a
 * `formKey` it hands to its sheets; the draft goes when the form closes.
 */
import { useCallback, useSyncExternalStore } from "react";

import type { EventDraft } from "../../../logic/eventForm.ts";

const drafts = new Map<string, EventDraft>();
const listeners = new Map<string, Set<() => void>>();

function notify(formKey: string): void {
  listeners.get(formKey)?.forEach((listen) => listen());
}

export function openDraft(formKey: string, draft: EventDraft): void {
  drafts.set(formKey, draft);
  notify(formKey);
}

/** Change an open draft; a change to a closed one is dropped. */
export function updateDraft(formKey: string, change: (d: EventDraft) => EventDraft): void {
  const current = drafts.get(formKey);
  if (!current) return;
  drafts.set(formKey, change(current));
  notify(formKey);
}

export function readDraft(formKey: string): EventDraft | undefined {
  return drafts.get(formKey);
}

export function subscribeDraft(formKey: string, listen: () => void): () => void {
  const set = listeners.get(formKey) ?? new Set();
  set.add(listen);
  listeners.set(formKey, set);
  return () => {
    set.delete(listen);
    if (set.size === 0) listeners.delete(formKey);
  };
}

export function closeDraft(formKey: string): void {
  drafts.delete(formKey);
  notify(formKey);
}

/** The draft of `formKey`, kept up to date; `undefined` once the form is closed. */
export function useDraft(formKey: string): EventDraft | undefined {
  const subscribe = useCallback((listen: () => void) => subscribeDraft(formKey, listen), [formKey]);
  return useSyncExternalStore(subscribe, () => drafts.get(formKey));
}
