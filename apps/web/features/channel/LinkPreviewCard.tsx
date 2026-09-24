import { Icon } from "@/components/ds";
import type { LinkPreview } from "@/lib/data";

/** From this width-to-height ratio on, an image is shown large under the text rather than beside it. */
const WIDE = 1.4;

/**
 * The preview of a message's first link, as the server read it (see `LinkPreview`): the site in its
 * own colour, the page's title and the start of its description, and its preview image.
 *
 * The image is a thumbnail the server fetched, stored and serves itself: the browser loads nothing
 * from the site. A wide image (a banner, a video frame) is drawn large under the text, a square one
 * (a logo, an avatar) small beside it, and the space is reserved from the stored size so the feed
 * does not jump when it arrives.
 *
 * A real link, opened in a new tab, with no referrer and no handle on this window. Leaving Ruchoir
 * goes through the external-link warning like any other link (see `ExternalLinkDialog`).
 */
export function LinkPreviewCard({ link }: { link: LinkPreview }) {
  const ratio = link.imageWidth && link.imageHeight ? link.imageWidth / link.imageHeight : 1;
  const wide = !!link.imageUrl && ratio >= WIDE;
  const side = !!link.imageUrl && !wide;
  const accent = link.color ?? "var(--border-strong)";

  const image = link.imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin thumbnail served by our API
    <img
      src={link.imageUrl}
      alt=""
      loading="lazy"
      style={
        wide
          ? {
              display: "block",
              width: "100%",
              aspectRatio: String(ratio),
              objectFit: "cover",
              marginTop: 10,
              borderRadius: "var(--radius-md)",
              background: "var(--surface-sunken)",
            }
          : {
              width: 72,
              height: 72,
              flex: "none",
              objectFit: "cover",
              borderRadius: "var(--radius-md)",
              background: "var(--surface-sunken)",
            }
      }
    />
  ) : null;

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
      {/* The site's colour, as a rail: enough to recognise it, never enough to fight the app's. */}
      <span aria-hidden style={{ width: 4, flex: "none", background: accent }} />
      <span style={{ flex: 1, minWidth: 0, padding: "10px 12px", display: "flex", gap: 12 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
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
          {wide ? image : null}
        </span>
        {side ? image : null}
      </span>
    </a>
  );
}
