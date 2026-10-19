import { useWindowDimensions } from "react-native";

import { isWide } from "./wide";

/** Whether the window is wide enough for the tablet layout (`wide.ts`); follows rotation and split view. */
export function useWide(): boolean {
  return isWide(useWindowDimensions().width);
}

/**
 * How a tablet holds its window (the tablet mockups): `landscape`, the list beside the conversation;
 * `portrait`, one of them at a time. Null for the phone's layout.
 */
export function useTabletLayout(): "landscape" | "portrait" | null {
  const { width, height } = useWindowDimensions();
  if (!isWide(width)) return null;
  return width > height ? "landscape" : "portrait";
}
