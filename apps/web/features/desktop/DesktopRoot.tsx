"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { configureClient } from "@ruchoir/client/config";
import { useTranslation } from "@/lib/i18n";
import { instanceState, onInstanceChanged, tauriInvoke, tauriListen, type InstanceView } from "@/lib/desktop/bridge";
import { createRelaySocket } from "@/lib/desktop/relaySocket";
import { desktopOs, instanceBase } from "@/lib/desktop/runtime";
import { requestSearch } from "@/lib/desktop/searchRequest";
import { AddInstanceScreen } from "./AddInstanceScreen";
import { SignInWaitScreen } from "./SignInWaitScreen";
import { TitleBar } from "./TitleBar";
import { useWindowShape } from "./useWindowShape";
import "./desktop.css";

/**
 * The interface itself, loaded once an instance is signed in: the screens before it (add an
 * instance, sign in) stay light, which is most of the app's memory at its first start.
 */
const AppRoot = dynamic(() => import("@/features/app/AppRoot").then((m) => m.AppRoot), { ssr: false });

/** Point the web's default client at an instance, through the app's own protocol. */
function pointClientAt(view: InstanceView) {
  if (view.state === "signed_in" && view.id && view.origin) {
    const id = view.id;
    configureClient({
      baseUrl: instanceBase(id),
      // Public links and the socket's address name the instance itself, not the app's path to it.
      publicOrigin: view.origin,
      // The core holds the socket and its bearer; the interface hears its frames.
      openSocket: () => createRelaySocket(id, tauriListen, tauriInvoke),
    });
  }
}

/**
 * The desktop app's root: the title bar, then whichever screen the instance's state calls for.
 *
 * The web's screens run unchanged, on the default client pointed at the instance (`/i/<id>`, which
 * the core forwards with that instance's token). Step 1 holds one instance; when an instance signs
 * out (a 401, or "Sign out" in the interface) the core says so and this goes back to signing in.
 */
export function DesktopRoot() {
  const { t } = useTranslation();
  const [view, setView] = useState<InstanceView | null>(null);
  const [noKeychainSeen, setNoKeychainSeen] = useState(false);
  const { maximized, fullscreen } = useWindowShape();

  useEffect(() => {
    void instanceState().then(setView);
    const stop = onInstanceChanged(setView);
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  // Before the interface renders, so its first request already goes to the right instance.
  if (view) pointClientAt(view);

  const showNoKeychain = view !== null && !view.vault_persistent && view.state === "signed_in" && !noKeychainSeen;

  return (
    // Linux draws no corners or shadow for a frameless window: the app rounds its own, unless the
    // window fills the screen.
    <div className={`wc-desktop${desktopOs() === "linux" && !maximized && !fullscreen ? " wc-desktop--rounded" : ""}`}>
      {fullscreen ? null : <TitleBar maximized={maximized} onSearch={view?.state === "signed_in" ? requestSearch : undefined} />}
      {showNoKeychain ? (
        <div className="wc-desktop__notice" role="status">
          <span>{t("desktop.noKeychain")}</span>
          <button type="button" className="wc-desktop__notice-close" onClick={() => setNoKeychainSeen(true)}>
            {t("common.close")}
          </button>
        </div>
      ) : null}
      <div className="wc-desktop__body">
        {view === null ? null : view.state === "none" ? (
          <AddInstanceScreen />
        ) : view.state === "signed_in" ? (
          <AppRoot key={view.id} />
        ) : (
          <SignInWaitScreen view={view} />
        )}
      </div>
    </div>
  );
}
