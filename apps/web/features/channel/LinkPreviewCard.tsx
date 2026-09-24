import { Icon } from "@/components/ds";
import type { LinkPreview } from "@/lib/data";

/**
 * The preview of a message's first link: the site, the page's title and the start of its
 * description, as the server read them (see `LinkPreview`). No image: the server fetches none, and
 * the browser fetches nothing from the site at all.
 *
 * A real link, opened in a new tab, with no referrer and no handle on this window: the page on the
 * other end learns nothing about where it was clicked from.
 */
export function LinkPreviewCard({ link }: { link: LinkPreview }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      // The row underneath reacts to clicks (focus, thread); the link is the only thing clicked.
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        maxWidth: 460,
        marginTop: 8,
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        background: "var(--surface-card)",
        textDecoration: "none",
        cursor: "pointer",
      }}
    >
      <span aria-hidden style={{ width: 4, flex: "none", background: "var(--border-strong)" }} />
      <span style={{ flex: 1, minWidth: 0, padding: "10px 12px" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          <Icon name="globe" size={12} />
          {link.domain}
        </span>
        {link.title ? (
          <span
            style={{
              display: "block",
              marginTop: 3,
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-strong)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {link.title}
          </span>
        ) : null}
        {link.description ? (
          <span
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              marginTop: 3,
              fontSize: 13,
              lineHeight: "var(--leading-snug)",
              color: "var(--text-muted)",
            }}
          >
            {link.description}
          </span>
        ) : null}
      </span>
    </a>
  );
}
