/** The name a download is saved under: the link's own (`download="…"`), else its address's last part. */
export function downloadName(href: string, named: string | null | undefined): string {
  const own = named?.trim();
  if (own) return own;
  let last = "";
  try {
    last = decodeURIComponent(new URL(href, "http://x").pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    last = "";
  }
  return last || "download";
}
