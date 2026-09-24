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
 * shipping all of them to every browser to draw four is the cost this avoids. Sources: Slack,
 * Mattermost and Teams from Iconify `logos` (`slack-icon`, `mattermost-icon`, `microsoft-teams`, its
 * internal ids renamed so they cannot collide with anything else on the page); Nextcloud - absent from
 * `logos`, and a single-colour mark by brand - from simple-icons, tinted its own #0082C9.
 */
type BrandMark = { viewBox: string; body: string };

const BRANDS: Record<"Slack" | "Mattermost" | "Nextcloud" | "Teams", BrandMark> = {
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
  Teams: {
    viewBox: "0 0 256 239",
    body: '<defs><linearGradient id="ruchoir-brand-teams-tile" x1="17.372%" x2="82.628%" y1="-6.51%" y2="106.51%"><stop offset="0%" stop-color="#5a62c3"/><stop offset="50%" stop-color="#4d55bd"/><stop offset="100%" stop-color="#3940ab"/></linearGradient><path id="ruchoir-brand-teams-fold" d="M136.93 64.476v12.8a32.7 32.7 0 0 1-5.953-.952a38.7 38.7 0 0 1-26.79-22.742h21.848c6.008.022 10.872 4.887 10.895 10.894"/></defs><path fill="#5059c9" d="M178.563 89.302h66.125c6.248 0 11.312 5.065 11.312 11.312v60.231c0 22.96-18.613 41.574-41.573 41.574h-.197c-22.96.003-41.576-18.607-41.579-41.568V95.215a5.91 5.91 0 0 1 5.912-5.913"/><circle cx="223.256" cy="50.605" r="26.791" fill="#5059c9"/><circle cx="139.907" cy="38.698" r="38.698" fill="#7b83eb"/><path fill="#7b83eb" d="M191.506 89.302H82.355c-6.173.153-11.056 5.276-10.913 11.449v68.697c-.862 37.044 28.445 67.785 65.488 68.692c37.043-.907 66.35-31.648 65.489-68.692v-68.697c.143-6.173-4.74-11.296-10.913-11.449"/><path d="M142.884 89.302v96.268a10.96 10.96 0 0 1-6.787 10.062c-1.3.55-2.697.833-4.108.833H76.68c-.774-1.965-1.488-3.93-2.084-5.953a72.5 72.5 0 0 1-3.155-21.076v-68.703c-.143-6.163 4.732-11.278 10.895-11.43z" opacity=".1"/><path d="M136.93 89.302v102.222c0 1.411-.283 2.808-.833 4.108a10.96 10.96 0 0 1-10.062 6.787H79.48c-1.012-1.965-1.965-3.93-2.798-5.954a59 59 0 0 1-2.084-5.953a72.5 72.5 0 0 1-3.155-21.076v-68.703c-.143-6.163 4.732-11.278 10.895-11.43z" opacity=".2"/><path d="M136.93 89.302v90.315c-.045 5.998-4.896 10.85-10.895 10.895H74.597a72.5 72.5 0 0 1-3.155-21.076v-68.703c-.143-6.163 4.732-11.278 10.895-11.43z" opacity=".2"/><path d="M130.977 89.302v90.315c-.046 5.998-4.897 10.85-10.895 10.895H74.597a72.5 72.5 0 0 1-3.155-21.076v-68.703c-.143-6.163 4.732-11.278 10.895-11.43z" opacity=".2"/><path d="M142.884 58.523v18.753c-1.012.06-1.965.12-2.977.12s-1.965-.06-2.977-.12a32.7 32.7 0 0 1-5.953-.952a38.7 38.7 0 0 1-26.791-22.742a33 33 0 0 1-1.905-5.954h29.708c6.007.023 10.872 4.887 10.895 10.895" opacity=".1"/><use href="#ruchoir-brand-teams-fold" opacity=".2"/><use href="#ruchoir-brand-teams-fold" opacity=".2"/><path d="M130.977 64.476v11.848a38.7 38.7 0 0 1-26.791-22.743h15.896c6.008.023 10.872 4.888 10.895 10.895" opacity=".2"/><path fill="url(#ruchoir-brand-teams-tile)" d="M10.913 53.581h109.15c6.028 0 10.914 4.886 10.914 10.913v109.151c0 6.027-4.886 10.913-10.913 10.913H10.913C4.886 184.558 0 179.672 0 173.645V64.495C0 58.466 4.886 53.58 10.913 53.58"/><path fill="#fff" d="M94.208 95.125h-21.82v59.416H58.487V95.125H36.769V83.599h57.439z"/>',
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
