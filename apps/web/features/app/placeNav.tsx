"use client";

import { createContext, useContext } from "react";
import type { Place } from "../settings/usedInLogic.ts";

/** How a screen far from the app's navigation (a dialog in the settings) sends a person to a place. */
export const PlaceNavContext = createContext<((place: Place) => void) | null>(null);

export function usePlaceNav(): ((place: Place) => void) | null {
  return useContext(PlaceNavContext);
}
