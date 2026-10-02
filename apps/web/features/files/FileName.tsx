import type { CSSProperties } from "react";

/**
 * A file name that shortens from its end while keeping its extension in view: "Récapitulatif m….docx"
 * rather than "Récapitulatif me….(". The base takes whatever room is left, the extension never
 * shrinks, so the cut follows the space the name actually has rather than a character count.
 */
export function FileName({ name, isFolder = false, style }: { name: string; isFolder?: boolean; style?: CSSProperties }) {
  const dot = name.lastIndexOf(".");
  const split = !isFolder && dot > 0 && name.length - dot <= 6;
  const base = split ? name.slice(0, dot) : name;
  const ext = split ? name.slice(dot) : "";
  return (
    <span title={name} style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%", whiteSpace: "nowrap", ...style }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{base}</span>
      {ext ? <span style={{ flex: "none" }}>{ext}</span> : null}
    </span>
  );
}
