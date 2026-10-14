/**
 * A value chosen in a sheet, handed back to the form still mounted under it (the profile's time
 * zone), as the event form's series scope is (`agenda/form/scope.ts`).
 */
import { useEffect, useRef } from "react";

type Choice = { key: string; value: string };

const listeners = new Set<(choice: Choice) => void>();

export function choose(key: string, value: string): void {
  listeners.forEach((listen) => listen({ key, value }));
}

/** Hear what is chosen for `key`. */
export function useChoice(key: string, onChoose: (value: string) => void): void {
  const latest = useRef(onChoose);
  useEffect(() => {
    latest.current = onChoose;
  });
  useEffect(() => {
    const listen = (choice: Choice) => {
      if (choice.key === key) latest.current(choice.value);
    };
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  }, [key]);
}
