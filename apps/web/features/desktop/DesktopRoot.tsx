"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { configureClient } from "@ruchoir/client/config";
import { Button, Dialog } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { cancelAll, isBusy } from "@/lib/uploads";
import {
  desktopSettings,
  instanceOpen,
  instanceRemove,
  instancesState,
  onDesktopOpen,
  onInstancesChanged,
  onSummaryChanged,
  preferencesChanged,
  setDesktopSettings,
  setShellLabels,
  summaries,
  tauriInvoke,
  tauriListen,
  type InstanceView,
} from "@/lib/desktop/bridge";
import { shortLabel, type DesktopSettings, type Summary } from "@/lib/desktop/instances";
import { createRelaySocket } from "@/lib/desktop/relaySocket";
import { desktopOs, instanceBase } from "@/lib/desktop/runtime";
import { requestSearch } from "@/lib/desktop/searchRequest";
import { guardedSwitch } from "@/lib/desktop/switchGuard";
import { AddInstanceScreen } from "./AddInstanceScreen";
import { DesktopContext, type DesktopBridge } from "./DesktopContext";
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

/** Write the path the next interface opens at (it reads its address when it starts). */
function goTo(path: string) {
  try {
    window.history.replaceState(null, "", path);
  } catch {
    // An address that cannot be written: the interface opens at its default place.
  }
}

/**
 * The desktop app's root: the title bar, then whichever screen the open instance's state calls for.
 *
 * One interface at a time (ADR 0008, step 2): the web's screens run unchanged on the default client,
 * pointed at the open instance (`/i/<id>`, forwarded by the core with its token). Opening another
 * instance mounts a fresh interface (its key), after asking when files are being sent. The other
 * instances reach the interface through `DesktopContext`: their spaces and counts, kept by the core.
 */
export function DesktopRoot() {
  const { t } = useTranslation();
  const [views, setViews] = useState<InstanceView[] | null>(null);
  const [sums, setSums] = useState<Record<string, Summary>>({});
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  // Bumped to mount a fresh interface at a new address within the same instance (a notification).
  const [generation, setGeneration] = useState(0);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState<((answer: "wait" | "cancel") => void) | null>(null);
  const [noKeychainSeen, setNoKeychainSeen] = useState(false);
  const { maximized, fullscreen } = useWindowShape();

  useEffect(() => {
    void instancesState().then(setViews);
    void summaries().then(setSums);
    void desktopSettings().then(setSettings);
    const stops = [
      onInstancesChanged(setViews),
      onSummaryChanged((instance, summary) => setSums((prev) => ({ ...prev, [instance]: summary }))),
      onDesktopOpen((_instance, path) => {
        goTo(path);
        setGeneration((g) => g + 1);
      }),
    ];
    return () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, []);

  // The tray's words follow the interface's language.
  useEffect(() => {
    void setShellLabels({ open: t("desktop.tray.open"), quit: t("desktop.tray.quit"), closed_to_tray: t("desktop.tray.closedNotice") });
  }, [t]);

  const open = views?.find((v) => v.open) ?? null;
  // Before the interface renders, so its first request already goes to the right instance.
  if (open) pointClientAt(open);

  const switchTo = useCallback((id: string, path: string) => {
    void guardedSwitch(
      isBusy,
      () => new Promise((resolve) => setAsking(() => resolve)),
      cancelAll,
      () => {
        goTo(path);
        setAdding(false);
        void instanceOpen(id);
        setGeneration((g) => g + 1);
      },
    );
  }, []);

  const bridge = useMemo<DesktopBridge | null>(() => {
    if (!open?.id || !views) return null;
    const host = open.name ?? "";
    return {
      instanceLabel: shortLabel(host),
      instanceHost: host,
      others: views
        .filter((v) => !v.open && v.id)
        .map((v) => ({
          id: v.id as string,
          label: shortLabel(v.name ?? ""),
          host: v.name ?? "",
          state: v.state === "signed_in" ? ("signedIn" as const) : ("signedOut" as const),
          spaces: sums[v.id as string]?.spaces ?? [],
          base: instanceBase(v.id as string),
        })),
      open: switchTo,
      addInstance: () => setAdding(true),
      signIn: (id) => switchTo(id, "/"),
      removeOpen: () => void instanceRemove(open.id as string),
      preferencesSaved: () => void preferencesChanged(open.id as string),
      settings,
      setSettings: (next) => void setDesktopSettings(next).then(setSettings),
    };
  }, [open, views, sums, settings, switchTo]);

  // Another signed-in instance to go back to from an add or sign-in screen.
  const back = views?.find((v) => !v.open && v.state === "signed_in" && v.id) ?? null;
  const goBack = back ? () => switchTo(back.id as string, "/") : undefined;

  const showNoKeychain = open !== null && !open.vault_persistent && open.state === "signed_in" && !noKeychainSeen;

  let body = null;
  if (views !== null) {
    if (adding || !open) {
      body = <AddInstanceScreen onAdded={() => setAdding(false)} onCancel={views.length > 0 ? () => setAdding(false) : undefined} />;
    } else if (open.state === "signed_in") {
      body = (
        <DesktopContext.Provider value={bridge}>
          <AppRoot key={`${open.id}:${generation}`} />
        </DesktopContext.Provider>
      );
    } else {
      body = <SignInWaitScreen view={open} onBack={goBack} />;
    }
  }

  return (
    // Linux draws no corners or shadow for a frameless window: the app rounds its own, unless the
    // window fills the screen.
    <div className={`wc-desktop${desktopOs() === "linux" && !maximized && !fullscreen ? " wc-desktop--rounded" : ""}`}>
      {fullscreen ? null : <TitleBar maximized={maximized} onSearch={open?.state === "signed_in" && !adding ? requestSearch : undefined} />}
      {showNoKeychain ? (
        <div className="wc-desktop__notice" role="status">
          <span>{t("desktop.noKeychain")}</span>
          <button type="button" className="wc-desktop__notice-close" onClick={() => setNoKeychainSeen(true)}>
            {t("common.close")}
          </button>
        </div>
      ) : null}
      <div className="wc-desktop__body">{body}</div>
      {asking ? (
        <Dialog
          title={t("desktop.switch.title")}
          onClose={() => {
            asking("wait");
            setAsking(null);
          }}
          closeLabel={t("common.close")}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  asking("cancel");
                  setAsking(null);
                }}
              >
                {t("desktop.switch.cancelSends")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  asking("wait");
                  setAsking(null);
                }}
              >
                {t("desktop.switch.wait")}
              </Button>
            </>
          }
        >
          <p>{t("desktop.switch.body", { host: open?.name ?? "" })}</p>
        </Dialog>
      ) : null}
    </div>
  );
}
