/**
 * Phone or tablet (step 6e). A tablet is a screen whose shorter side is at least 600 points (Android's
 * own threshold, every iPad); the wide layout (the tabs as a side rail, the discussions in two
 * columns) is for a window at least 768 points wide, so an iPad in portrait or split view keeps the
 * phone's when it is narrower. Free of React Native so Node tests it.
 */

export const TABLET_SHORTEST = 600;
export const WIDE = 768;

export function isTablet(width: number, height: number): boolean {
  return Math.min(width, height) >= TABLET_SHORTEST;
}

export function isWide(width: number): boolean {
  return width >= WIDE;
}
