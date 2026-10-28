"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createClient, type RuchoirClient } from "@ruchoir/client";
import { configureClient } from "@ruchoir/client/config";
import { Button, Dialog } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { cancelAll, isBusy } from "@/lib/uploads";
import {
  desktopSettings,
  instanceOpen,
  instanceRemove,
  quitApp,
  instancesState,
  onDesktopOpen,
  onInstancesChanged,
  onSummaryChanged,
  onUpdateAvailable,
  preferencesChanged,
  setDesktopSettings,
  setShellLabels,
  summaries,
  tauriInvoke,
  tauriListen,
  updateInstall,
  updateState,
  type UpdateOffer,
  type InstanceView,
} from "@/lib/desktop/bridge";
import { shortLabel, type DesktopSettings, type Summary } from "@/lib/desktop/instances";
import { catchDownloads } from "@/lib/desktop/downloads";
import { createRelaySocket } from "@/lib/desktop/relaySocket";
import { desktopOs, instanceBase } from "@/lib/desktop/runtime";
import { requestSearch } from "@/lib/desktop/searchRequest";
import { afterOpen, guardedSwitch } from "@/lib/desktop/switchGuard";
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
  const { maximized, fullscreen } = useWindowShape();
  const viewsRef = useRef<InstanceView[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A client per other instance, for what the desktop sends them itself (notification settings).
  const clients = useRef(new Map<string, RuchoirClient>());
  const clientOf = (id: string, origin: string | null) => {
    let client = clients.current.get(id);
    if (!client) {
      // Same origin as the interface: the core adds this instance's token on the way.
      client = createClient({ baseUrl: instanceBase(id), publicOrigin: origin ?? undefined });
      clients.current.set(id, client);
    }
    return client;
  };
  const stillRef = useRef<HTMLDivElement>(null);
  const stillTimer = useRef<number | undefined>(undefined);

  const releaseStill = useCallback(() => {
    const still = stillRef.current;
    if (!still?.classList.contains("wc-desktop__still--on")) return;
    window.clearTimeout(stillTimer.current);
    still.classList.remove("wc-desktop__still--on");
    window.setTimeout(() => still.replaceChildren(), 200);
  }, []);

  /**
   * Hold a still of the interface on screen while the next instance's loads under it (switching
   * instance remounts the interface: without it, the window flashes through an empty frame). The
   * still is a copy of the page as it stands, scroll positions included, inert; it fades out when
   * the new interface says it is ready, or after ten seconds at most.
   */
  const holdStill = useCallback(() => {
    const live = bodyRef.current?.firstElementChild;
    const still = stillRef.current;
    if (!live || !still || live === still) return;
    const copy = live.cloneNode(true) as HTMLElement;
    copy.setAttribute("inert", "");
    still.replaceChildren(copy);
    const from = [live, ...live.querySelectorAll("*")];
    const to = [copy, ...copy.querySelectorAll("*")];
    from.forEach((el, i) => {
      if (el.scrollTop || el.scrollLeft) {
        to[i].scrollTop = el.scrollTop;
        to[i].scrollLeft = el.scrollLeft;
      }
    });
    still.classList.add("wc-desktop__still--on");
    window.clearTimeout(stillTimer.current);
    stillTimer.current = window.setTimeout(() => releaseStill(), 10000);
  }, [releaseStill]);


  const openId = () => viewsRef.current?.find((v) => v.open)?.id ?? null;

  useEffect(() => {
    viewsRef.current = views;
  }, [views]);

  useEffect(() => {
    void instancesState().then(setViews);
    void summaries().then(setSums);
    void desktopSettings().then(setSettings);
    const stops = [
      onInstancesChanged(setViews),
      onSummaryChanged((instance, summary) => setSums((prev) => ({ ...prev, [instance]: summary }))),
      onDesktopOpen((instance, path) => {
        goTo(path);
        holdStill();
        if (afterOpen(openId(), instance) === "remount") setGeneration((g) => g + 1);
      }),
    ];
    return () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, [holdStill]);

  // Download links go to the core ("Save as", or the system's app for the calendar's PDF): the
  // webview saves nothing by itself. A failure says why, in a dialog.
  const [downloadError, setDownloadError] = useState<string | null>(null);
  useEffect(() => catchDownloads(setDownloadError), []);

  // A newer version, offered under the title bar until the person restarts into it.
  const [update, setUpdate] = useState<UpdateOffer | null>(null);
  const [installing, setInstalling] = useState(false);
  const [updateFailed, setUpdateFailed] = useState(false);
  useEffect(() => {
    void updateState().then((offer) => offer && setUpdate(offer));
    const stop = onUpdateAvailable(setUpdate);
    return () => void stop.then((unlisten) => unlisten());
  }, []);
  const install = () => {
    setInstalling(true);
    setUpdateFailed(false);
    // On success the app restarts into the new version; nothing comes back.
    void updateInstall()
      .catch(() => setUpdateFailed(true))
      .finally(() => setInstalling(false));
  };

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
        holdStill();
        if (afterOpen(openId(), id) === "remount") setGeneration((g) => g + 1);
        else void instanceOpen(id);
      },
    );
  }, [holdStill]);

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
      // The next instance opens at its own start, not at the removed one's last address.
      removeOpen: () => {
        goTo("/");
        void instanceRemove(open.id as string);
      },
      preferencesSaved: (prefs) => {
        void preferencesChanged(open.id as string);
        for (const view of views) {
          if (view.open || !view.id || view.state !== "signed_in") continue;
          const id = view.id;
          void clientOf(id, view.origin)
            .saveNotificationPreferences(prefs)
            .then(() => preferencesChanged(id))
            .catch(() => {});
        }
      },
      settings,
      setSettings: (next) => void setDesktopSettings(next).then(setSettings),
      interfaceReady: releaseStill,
      keychain: open.vault_persistent,
      quit: () => void quitApp(),
    };
  }, [open, views, sums, settings, switchTo, releaseStill]);

  // Another signed-in instance to go back to from an add or sign-in screen.
  const back = views?.find((v) => !v.open && v.state === "signed_in" && v.id) ?? null;
  const goBack = back ? () => switchTo(back.id as string, "/") : undefined;


  let body = null;
  if (views !== null) {
    if (!open) {
      body = <AddInstanceScreen onAdded={() => setAdding(false)} />;
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
  // Adding an instance from the interface lays the add screen over it: cancelling comes back to the
  // interface as it was, rather than to a fresh one.
  const addingOver = adding && open !== null;

  return (
    // Linux draws no corners or shadow for a frameless window: the app rounds its own, unless the
    // window fills the screen.
    <div className={`wc-desktop${desktopOs() === "linux" && !maximized && !fullscreen ? " wc-desktop--rounded" : ""}`}>
      {fullscreen ? null : <TitleBar maximized={maximized} onSearch={open?.state === "signed_in" && !addingOver ? requestSearch : undefined} />}
      {update ? (
        <div className="wc-desktop__update" role="status">
          <span>
            {updateFailed
              ? t("desktop.update.failed")
              : update.manual
                ? t("desktop.update.availableManual", { version: update.version })
                : t("desktop.update.available", { version: update.version })}
          </span>
          <Button size="sm" variant="primary" disabled={installing} onClick={install}>
            {update.manual ? t("message.download") : installing ? t("desktop.update.installing") : t("desktop.update.restart")}
          </Button>
        </div>
      ) : null}
      <div className="wc-desktop__body" ref={bodyRef}>
        {body}
        {addingOver ? (
          <div className="wc-desktop__over">
            <AddInstanceScreen onAdded={() => setAdding(false)} onCancel={() => setAdding(false)} />
          </div>
        ) : null}
        <div className="wc-desktop__still" ref={stillRef} aria-hidden="true" />
      </div>
      {downloadError ? (
        <Dialog
          title={t("desktop.download.title")}
          onClose={() => setDownloadError(null)}
          closeLabel={t("common.close")}
          footer={
            <Button variant="primary" onClick={() => setDownloadError(null)}>
              {t("common.close")}
            </Button>
          }
        >
          <p>
            {/* The core's error codes (`downloads.rs`), each in words. */}
            {downloadError === "signed_out"
              ? t("desktop.download.signedOut")
              : downloadError === "unreachable"
                ? t("desktop.download.unreachable")
                : downloadError === "not_saved"
                  ? t("desktop.download.notSaved")
                  : downloadError === "no_app"
                    ? t("desktop.download.noApp")
                    : t("desktop.download.failed")}
          </p>
        </Dialog>
      ) : null}
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
