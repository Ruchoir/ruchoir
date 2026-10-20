// @ts-check

/**
 * Next.js configuration for Ruchoir.
 *
 * The web client is compiled to a fully static bundle (`output: "export"`) and served
 * by the Rust API. This rules out SSR, Server Actions, Next API routes and server-side
 * image optimization: all server logic lives in the Rust API. Keep within these limits.
 *
 * @type {import('next').NextConfig}
 */
/** The desktop app's build (`build:desktop`), which embeds the export in the Tauri app. */
const desktop = process.env.NEXT_PUBLIC_RUCHOIR_TARGET === "desktop";

const nextConfig = {
  output: "export",
  reactStrictMode: true,
  // Do not auto-generate an AGENTS.md: this repo maintains it by hand.
  agentRules: false,
  // Emit `foo/index.html` so paths resolve cleanly when served as static files.
  trailingSlash: true,
  // The static export cannot use the server image optimizer.
  images: { unoptimized: true },
  // Workspace packages shipped as TypeScript source: the API client (shared with the mobile app) and
  // the design system (shared with Ruchoir Lab).
  transpilePackages: ["@ruchoir/client", "@ruchoir/design-system"],
  // The web build resolves the desktop root to an empty module, so no desktop code ships to browsers.
  turbopack: {
    resolveAlias: desktop
      ? {}
      : { "@/features/desktop/DesktopEntry": "./features/desktop/DesktopEntry.web.tsx" },
  },
};

export default nextConfig;
