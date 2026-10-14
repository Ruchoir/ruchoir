/**
 * The scope chosen for a change to a date of a series, handed back from its sheet to whoever asked
 * (the form saving, the summary deleting), which is still mounted under the sheet.
 */
import type { EditScope } from "@ruchoir/client";
import { useEffect, useRef } from "react";

export type ScopeRequest = { key: string; scope: EditScope };

const listeners = new Set<(request: ScopeRequest) => void>();

export function requestScope(request: ScopeRequest): void {
  listeners.forEach((listen) => listen(request));
}

/** Hear the scopes chosen for `key`. */
export function useScopeRequests(key: string, onScope: (scope: EditScope) => void): void {
  const latest = useRef(onScope);
  useEffect(() => {
    latest.current = onScope;
  });
  useEffect(() => {
    const listen = (request: ScopeRequest) => {
      if (request.key === key) latest.current(request.scope);
    };
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  }, [key]);
}
