import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ruchoir",
  // i18n-audit-ignore-next-line -- document metadata of a static export: one HTML file is served to
  // every reader, so this sentence cannot follow a language. English, like the rest of the repository.
  description: "Sovereign, open-core workspace: real-time team messaging and file sharing.",
  applicationName: "Ruchoir",
};

export const viewport: Viewport = {
  themeColor: "#c65d45",
  width: "device-width",
  initialScale: 1,
};

// Applied before first paint so the stored appearance is in place with no flash of the defaults.
// Kept inline and tiny: reads the persisted settings and stamps data-theme/font/text on <html>.
// Only non-default values are stamped, matching how the CSS defaults are the bare :root.
const themeBootstrap = `try{var s=JSON.parse(localStorage.getItem("ruchoir.settings")||"{}"),d=document.documentElement.dataset;if(s.theme==="light"||s.theme==="ruchui-dark"||s.theme==="dark")d.theme=s.theme;if(s.font==="system"||s.font==="dyslexic")d.font=s.font;if(s.textSize==="s"||s.textSize==="l"||s.textSize==="xl")d.text=s.textSize;}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // No data-theme is rendered server-side: the CSS :root IS the default RuchUI theme, and the
    // pre-paint script only stamps data-theme for a non-default stored theme. Because React never
    // renders the attribute, the script-added one is unmanaged and cannot cause a hydration mismatch.
    // suppressHydrationWarning still covers the injected <script> text differing across environments.
    // The UI copy is French, so the document language is fr: a screen reader must pick the French
    // speech synthesiser to pronounce the content correctly (the repo/code convention stays English).
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
