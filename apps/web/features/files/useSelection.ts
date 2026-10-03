"use client";

import { useCallback, useState } from "react";
import { rangeBetween } from "./model";

export type ClickModifiers = { ctrl: boolean; shift: boolean };

/**
 * The selection of a file list, by key, over the order the list is shown in.
 *
 * A plain click selects one entry, Ctrl (Cmd on a Mac) adds or removes one, Shift extends from the
 * last entry clicked (the anchor) to this one, as in a desktop file manager. Ranges are taken on
 * `order`, the visible order, so they follow the sort and the filter.
 */
export function useSelection(order: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const click = useCallback(
    (key: string, mods: ClickModifiers) => {
      if (mods.shift && anchor) {
        const range = rangeBetween(order, anchor, key);
        setSelected((prev) => (mods.ctrl ? new Set([...prev, ...range]) : new Set(range)));
        return;
      }
      setAnchor(key);
      if (mods.ctrl) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      } else {
        setSelected(new Set([key]));
      }
    },
    [anchor, order],
  );

  /** A checkbox: add or remove one entry, leaving the others. */
  const toggle = useCallback((key: string) => click(key, { ctrl: true, shift: false }), [click]);

  const selectAll = useCallback(() => setSelected(new Set(order)), [order]);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  /** Select exactly `keys` (a keyboard move, a long press), the last one becoming the anchor. */
  const set = useCallback((keys: string[]) => {
    setSelected(new Set(keys));
    setAnchor(keys[keys.length - 1] ?? null);
  }, []);

  return { selected, anchor, click, toggle, selectAll, clear, set };
}
