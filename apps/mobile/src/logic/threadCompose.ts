/**
 * What closes a thread screen: the composer, the read-only note, or (while the channel's rights
 * are still being read) a neutral gap of the same height, so the footer does not flip from one to
 * the other when the answer comes.
 */
export function threadFooter(s: { signedIn: boolean; inChannel: boolean; channelsLoaded: boolean; canSend: boolean }): "none" | "waiting" | "readOnly" | "composer" {
  if (!s.signedIn) return "none";
  if (s.inChannel && !s.channelsLoaded) return "waiting";
  return s.canSend ? "composer" : "readOnly";
}
