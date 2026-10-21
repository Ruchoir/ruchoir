"use client";

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Whether the window is maximised or full screen, kept current as it changes. */
export function useWindowShape(): { maximized: boolean; fullscreen: boolean } {
  const [shape, setShape] = useState({ maximized: false, fullscreen: false });

  useEffect(() => {
    const win = getCurrentWindow();
    const read = () => {
      void Promise.all([win.isMaximized(), win.isFullscreen()]).then(([maximized, fullscreen]) =>
        setShape((prev) => (prev.maximized === maximized && prev.fullscreen === fullscreen ? prev : { maximized, fullscreen })),
      );
    };
    read();
    const stop = win.onResized(read);
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  return shape;
}
