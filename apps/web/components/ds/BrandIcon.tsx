import type { CSSProperties } from "react";

/**
 * Third-party product logos, in their own colours, for saying where imported data came from.
 *
 * The `Icon` component's sovereignty rule (lucide-only, no CDN) governs the app's *own* glyphs. A
 * provenance mark is a different thing: it has to be Slack's logo, in Slack's colours, or it says
 * nothing. Rendered inline like `Icon` - no runtime network, CSP-safe.
 *
 * The marks are inlined as static SVG on purpose rather than pulled from a runtime package. A
 * full-colour brand set (Iconify `logos`, kept as a devDependency) carries ~2000 icons, and
 * shipping all of them to every browser to draw three is the cost this avoids. Sources: Slack and
 * Mattermost from Iconify `logos` (`slack-icon`, `mattermost-icon`); Nextcloud - absent from
 * `logos`, and a single-colour mark by brand - from simple-icons, tinted its own #0082C9.
 */
type BrandMark = { viewBox: string; body: string };

const BRANDS: Record<"Slack" | "Mattermost" | "Nextcloud", BrandMark> = {
  Slack: {
    viewBox: "0 0 256 256",
    body: '<path fill="#e01e5a" d="M53.841 161.32c0 14.832-11.987 26.82-26.819 26.82S.203 176.152.203 161.32c0-14.831 11.987-26.818 26.82-26.818H53.84zm13.41 0c0-14.831 11.987-26.818 26.819-26.818s26.819 11.987 26.819 26.819v67.047c0 14.832-11.987 26.82-26.82 26.82c-14.83 0-26.818-11.988-26.818-26.82z"/><path fill="#36c5f0" d="M94.07 53.638c-14.832 0-26.82-11.987-26.82-26.819S79.239 0 94.07 0s26.819 11.987 26.819 26.819v26.82zm0 13.613c14.832 0 26.819 11.987 26.819 26.819s-11.987 26.819-26.82 26.819H26.82C11.987 120.889 0 108.902 0 94.069c0-14.83 11.987-26.818 26.819-26.818z"/><path fill="#2eb67d" d="M201.55 94.07c0-14.832 11.987-26.82 26.818-26.82s26.82 11.988 26.82 26.82s-11.988 26.819-26.82 26.819H201.55zm-13.41 0c0 14.832-11.988 26.819-26.82 26.819c-14.831 0-26.818-11.987-26.818-26.82V26.82C134.502 11.987 146.489 0 161.32 0s26.819 11.987 26.819 26.819z"/><path fill="#ecb22e" d="M161.32 201.55c14.832 0 26.82 11.987 26.82 26.818s-11.988 26.82-26.82 26.82c-14.831 0-26.818-11.988-26.818-26.82V201.55zm0-13.41c-14.831 0-26.818-11.988-26.818-26.82c0-14.831 11.987-26.818 26.819-26.818h67.25c14.832 0 26.82 11.987 26.82 26.819s-11.988 26.819-26.82 26.819z"/>',
  },
  Mattermost: {
    viewBox: "0 0 256 256",
    body: '<path fill="#0058cc" d="M6.791 86.965C25.235 32.482 76.783-1.432 131.421.046L113.91 20.74C81.496 26.6 53.507 48.735 42.507 81.23c-16.366 48.347 11.066 101.317 61.272 118.315c50.207 16.994 104.174-8.421 120.54-56.766c10.965-32.387 2.27-66.847-19.756-91.18l-1.346-27.169c44.154 32.048 64.406 90.205 45.991 144.6c-22.662 66.941-95.298 102.837-162.24 80.176c-66.94-22.662-102.837-95.299-80.177-162.24m158.394-75.041a2.96 2.96 0 0 1 2.137-.098a2.97 2.97 0 0 1 1.614 1.334l.072.116l.064.134c.168.321.311.69.378 1.141c.132.89.192 2.985.216 5.13l.005.585c.006.683.009 1.36.01 1.994v.532c-.002 1.735-.017 3.035-.017 3.035l.503 18.933l.744 21.855l.927 37.98v.083l.001.045v.121c-.007 2.17-.452 18.049-11.717 29.085c-12.112 11.866-26.99 10.78-36.67 7.504c-9.68-3.278-22.158-11.453-24.572-28.237c-2.052-14.266 5.533-26.257 7.854-29.533l.155-.217c.316-.438.5-.668.5-.668l23.808-29.606l13.868-16.91l11.9-14.734s1.75-2.345 3.551-4.653l.36-.46a111 111 0 0 1 1.718-2.141l.305-.366c.444-.527.82-.952 1.085-1.208c.308-.3.625-.494.935-.645l.227-.116Z"/>',
  },
  Nextcloud: {
    viewBox: "0 0 24 24",
    body: '<path fill="#0082C9" d="M12.018 6.537c-2.5 0-4.6 1.712-5.241 4.015-.56-1.232-1.793-2.105-3.225-2.105A3.569 3.569 0 0 0 0 12a3.569 3.569 0 0 0 3.552 3.553c1.432 0 2.664-.874 3.224-2.106.641 2.304 2.742 4.016 5.242 4.016 2.487 0 4.576-1.693 5.231-3.977.569 1.21 1.783 2.067 3.198 2.067A3.568 3.568 0 0 0 24 12a3.569 3.569 0 0 0-3.553-3.553c-1.416 0-2.63.858-3.199 2.067-.654-2.284-2.743-3.978-5.23-3.977zm0 2.085c1.878 0 3.378 1.5 3.378 3.378 0 1.878-1.5 3.378-3.378 3.378A3.362 3.362 0 0 1 8.641 12c0-1.878 1.5-3.378 3.377-3.378zm-8.466 1.91c.822 0 1.467.645 1.467 1.468s-.644 1.467-1.467 1.468A1.452 1.452 0 0 1 2.085 12c0-.823.644-1.467 1.467-1.467zm16.895 0c.823 0 1.468.645 1.468 1.468s-.645 1.468-1.468 1.468A1.452 1.452 0 0 1 18.98 12c0-.823.644-1.467 1.467-1.467z"/>',
  },
};

export type BrandName = keyof typeof BRANDS;

/** The logo that names a source, or null for one with none of its own (our product, or unknown). */
export function brandFor(source: string | null | undefined): BrandName | null {
  return source && source in BRANDS ? (source as BrandName) : null;
}

export type BrandIconProps = {
  name: BrandName;
  size?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
};

/** A product logo in its own colours, sized square. */
export function BrandIcon({ name, size = 16, title, className, style }: BrandIconProps) {
  const mark = BRANDS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      className={className}
      style={style}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      // Static, local, brand-coloured SVG paths - no user input, no network.
      dangerouslySetInnerHTML={{ __html: mark.body }}
    />
  );
}
