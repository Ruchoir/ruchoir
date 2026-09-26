import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ruchoir",
  // i18n-audit-ignore-next-line -- document metadata of a static export: one HTML file is served to
  // every reader, so this sentence cannot follow a language. English, like the rest of the repository.
  description: "Sovereign, open-core workspace: real-time team messaging and file sharing.",
  applicationName: "Ruchoir",
  // Installable app: the manifest names it and its icons (`public/icons/`, drawn by
  // `scripts/build-pwa-icons.mjs`), and iOS reads its own tags to run it full screen once it is on the
  // home screen, which is also the only way Safari there offers push notifications.
  manifest: "/manifest.webmanifest",
  // "default": an opaque status bar, with the page starting below it. Drawing under it
  // ("black-translucent") let iOS 26+ paint its Liquid Glass blur over the top of the header in the
  // installed app, and iOS 27 made that a visible wash. iOS reads this once, at install.
  appleWebApp: { capable: true, title: "Ruchoir", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#f6f7f9",
  width: "device-width",
  initialScale: 1,
  // An installed app, not a page: no pinch zoom, and no jump in when a field under 16px takes the
  // focus (iOS zooms on those). The text size setting is how a reader enlarges it.
  maximumScale: 1,
  userScalable: false,
  // The page draws under the notch and the home indicator, and keeps clear of them itself with
  // `env(safe-area-inset-*)`: the shell's headers pad the top, the tab bar and the composer the
  // bottom. Without this those insets read 0, the tab bar sat on the home indicator, and the top of
  // the screen was the system's (with its blur) rather than the header's.
  viewportFit: "cover",
};

// Applied before first paint so the stored appearance is in place with no flash of the defaults.
// Kept inline and tiny: reads the persisted settings and stamps data-theme/font/text on <html>.
// Only non-default values are stamped, matching how the CSS defaults are the bare :root. The theme is
// the accent plus the mode (day, night, or the device's own in automatic); a single stored `theme`
// from before is read for what it meant, as SettingsProvider does.
const themeBootstrap = `try{var s=JSON.parse(localStorage.getItem("ruchoir.settings")||"{}"),d=document.documentElement.dataset;var A=/^(sky|mint|violet|pink)$/,a=s.accent,m=s.mode,t=s.theme||"";if(!A.test(a)){var p=t.split(/-(?=dark$)/);a=A.test(p[0])?p[0]:"sky";m=t?(p[1]==="dark"||t==="dark"?"night":"day"):"day";}var n=m==="night"||(m==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches),h=a+(n?"-dark":"");if(h!=="sky")d.theme=h;if(s.font==="system"||s.font==="dyslexic")d.font=s.font;if(s.textSize==="s"||s.textSize==="l"||s.textSize==="xl")d.text=s.textSize;}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // No data-theme is rendered server-side: the CSS :root IS the default theme (sky, by day), and the
    // pre-paint script only stamps data-theme for a non-default stored theme. Because React never
    // renders the attribute, the script-added one is unmanaged and cannot cause a hydration mismatch.
    // suppressHydrationWarning still covers the injected <script> text differing across environments.
    // The UI copy is French, so the document language is fr: a screen reader must pick the French
    // speech synthesiser to pronounce the content correctly (the repo/code convention stays English).
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        {/* What iOS samples to colour the band at the top of the installed app: a real element's
            background-color at the top edge (not rendered pixels, so not a gradient or a pseudo-element).
            Where it finds nothing solid it fills the band with its blur instead. */}
        <div aria-hidden style={{ position: "fixed", top: 0, left: 0, right: 0, height: 1, zIndex: 0, background: "var(--surface-canvas)" }} />
        {children}
      </body>
    </html>
  );
}
