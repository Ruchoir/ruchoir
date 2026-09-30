import type { CSSProperties } from "react";

const bar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: "var(--topbar-height)",
  flex: "none",
  padding: "0 14px",
  borderBottom: "1.5px solid var(--border-subtle)",
};

const lockup: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 9,
  fontFamily: "var(--font-sans)",
  fontSize: 19,
  fontWeight: 700,
  letterSpacing: "-0.03em",
  color: "var(--text-strong)",
};

const mark: CSSProperties = { width: 22, height: 22, flex: "none", display: "block" };

/** The terracotta belongs to the mark: the point after the name is its only other appearance. */
const point: CSSProperties = { color: "var(--brand)" };

/**
 * The name set as the public site sets it: the mark, then the name in bold type with its terracotta
 * point. Live text rather than an image, so it scales with the interface's text size.
 */
export function WordmarkLockup({ style }: { style?: CSSProperties }) {
  return (
    <span style={{ ...lockup, ...style }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/ruchoir-mark.png" alt="" style={mark} />
      <span>
        Ruchoir<span style={point}>.</span>
      </span>
    </span>
  );
}

/** Product wordmark bar, at the top of the sidebar. */
export function Wordmark() {
  return (
    <div style={bar}>
      <WordmarkLockup />
    </div>
  );
}
