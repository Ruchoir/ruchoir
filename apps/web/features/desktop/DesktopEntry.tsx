"use client";

import dynamic from "next/dynamic";

/**
 * The desktop root, loaded on the client only: it talks to the app's core, which a static
 * prerender has no access to.
 */
export const DesktopEntry = dynamic(() => import("./DesktopRoot").then((m) => m.DesktopRoot), { ssr: false });
