import { useWindowDimensions } from "react-native";

import { isWide } from "./wide";

/** Whether the window is wide enough for the tablet layout (`wide.ts`); follows rotation and split view. */
export function useWide(): boolean {
  return isWide(useWindowDimensions().width);
}
