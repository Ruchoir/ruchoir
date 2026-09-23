import type { CSSProperties, ReactNode } from "react";

/**
 * A placeholder drawn at the size of what is loading, so nothing moves when it lands.
 *
 * Quiet on purpose: a sunken shape with a slow sheen, never a spinner in the middle of a list. Under
 * reduced motion the sheen stops and the shape stays, which still says "something goes here".
 */
export type SkeletonProps = {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  /** A round placeholder, for an avatar. */
  circle?: boolean;
  style?: CSSProperties;
};

export function Skeleton({ width = "100%", height = 12, circle = false, style }: SkeletonProps) {
  return (
    <span
      className={circle ? "wc-skel wc-skel--circle" : "wc-skel"}
      style={{ width, height, flex: "none", ...style }}
      aria-hidden
    />
  );
}

/**
 * A group of placeholders standing for one thing that is loading, announced once.
 *
 * It appears after a short delay, so a load that answers quickly never flashes a skeleton at all.
 */
export function SkeletonGroup({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="wc-skel-group" role="status" aria-busy="true" style={style}>
      <span className="wc-visually-hidden">{label}</span>
      {children}
    </div>
  );
}
