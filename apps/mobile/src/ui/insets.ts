/**
 * The status bar and home indicator a full-screen modal keeps clear of: the live insets, or the
 * phone's own when the live ones read 0 there (they do in a full-screen modal on iOS, where a
 * `SafeAreaView` left the head of the event form under the clock).
 */
export function screenInsets(live: { top: number; bottom: number }, device: { top: number; bottom: number } | null): { top: number; bottom: number } {
  return { top: Math.max(live.top, device?.top ?? 0), bottom: Math.max(live.bottom, device?.bottom ?? 0) };
}
