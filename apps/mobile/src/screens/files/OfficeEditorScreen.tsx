/**
 * A document in the office editor, as the web's `OfficeEditor` (see `docs/office-editing.md`): a
 * Ruchoir band (the document, who is editing it, the way out) and the engine's own mobile editor
 * under it, in a web view on the editor's hostname.
 *
 * The token is posted as a form body, never in an address. The engine's page talks to its host with
 * WOPI post messages sent to `window.parent`; in a web view there is no parent (it is the page
 * itself), so a script run before the page gives that page alone a `parent` that hands each message
 * to the app. The engine's own inner frames keep their real parent, so they talk as before. What is
 * listened to: its close button (`UI_Close`), the first change (`Edit_Notification`, from which this
 * phone counts as editing, with a heartbeat), and Ruchoir's colours being on (`Ruchoir_Painted`,
 * which uncovers it).
 *
 * A legacy format is converted first (`convert`): the engine writes an editable copy, which is looked
 * for every few seconds and then opened instead, as on the web.
 */
import { isApiError, type FileEditor, type OfficeSession, type SpaceFile } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { usePrefs } from "../../prefs/store";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { AvatarStack } from "../../ui/AvatarStack";
import { Button } from "../../ui/Button";
import { FullScreen } from "../../ui/FullScreen";
import { Text } from "../../ui/Text";

/** How often an editing phone says it is still there (the API forgets it after 60 s). */
const HEARTBEAT_MS = 30_000;
/** How often a conversion asks whether the engine has written the copy yet, and for how long. */
const COPY_POLL_MS = 3_000;
const COPY_WAIT_MS = 120_000;
/** How long the editor may stay covered waiting for Ruchoir's colours before it shows anyway. */
const REVEAL_FALLBACK_MS = 15_000;

type Failure = "unavailable" | "unsupported" | "forbidden" | "missing" | "conversion" | "failed";

type State =
  | { status: "loading" }
  | { status: "ready"; session: OfficeSession; copy?: SpaceFile }
  | { status: "error"; reason: Failure };

function failureOf(err: unknown): Failure {
  if (isApiError(err, 503)) return "unavailable";
  if (isApiError(err, 403)) return "forbidden";
  if (isApiError(err, 400)) return "unsupported";
  if (isApiError(err, 404)) return "missing";
  return "failed";
}

/**
 * The WOPI page's `window.parent`, made the app: run before the page's scripts, on the top frame
 * only (`parent` is replaceable, so this shadows it there and nowhere else).
 */
const FORWARD = `(function () {
  var host = {
    postMessage: function (data) {
      try { if (typeof data === "string") window.ReactNativeWebView.postMessage(data); } catch (e) {}
    }
  };
  try {
    Object.defineProperty(window, "parent", { configurable: true, get: function () { return host; } });
  } catch (e) {
    window.parent = host;
  }
})(); true;`;

/** The engine configuration and token, as the form the web posts into its frame. */
function formBody(session: OfficeSession): string {
  const field = (name: string, value: string) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  return [
    field("access_token", session.accessToken),
    field("access_token_ttl", String(session.accessTokenTtl)),
    field("docs_api_config", session.config),
  ].join("&");
}

/** An id this screen keeps for its life, so the API tells two editors of one member apart. */
const newTab = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function OfficeEditorScreen() {
  const { endOfficeHeartbeat, getConvertedCopy, officeHeartbeat, openOfficeSession } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "officeEditor">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c, dark } = useTheme();
  const { accent } = usePrefs();
  const { emit } = useRealtimeActions();
  const [state, setState] = useState<State>({ status: "loading" });
  const [tab] = useState(newTab);
  const [editors, setEditors] = useState<FileEditor[]>([]);

  const open = useCallback(
    (fileId: string, convert: boolean) =>
      openOfficeSession(fileId, { theme: dark ? "dark" : "light", accent, mode: convert ? "convert" : undefined, mobile: true }),
    [openOfficeSession, dark, accent],
  );

  // Opened once: a change of theme while editing does not reload the document.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    open(params.fileId, !!params.convert).then(
      (session) => {
        setState({ status: "ready", session });
        setEditors(session.file.editors ?? []);
      },
      (err) => setState({ status: "error", reason: failureOf(err) }),
    );
  }, [open, params.fileId, params.convert]);

  // A conversion: ask until the engine has written the copy, then open the copy for editing.
  const awaitingCopy = state.status === "ready" && state.session.mode === "convert" && !state.copy;
  useEffect(() => {
    if (!awaitingCopy) return;
    let cancelled = false;
    let opening = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (opening) return;
      if (Date.now() - started > COPY_WAIT_MS) {
        clearInterval(timer);
        setState({ status: "error", reason: "conversion" });
        return;
      }
      getConvertedCopy(params.fileId)
        .then(async (found) => {
          if (cancelled || !found?.id) return;
          opening = true;
          const next = await open(found.id, false);
          if (!cancelled) setState({ status: "ready", session: next, copy: found });
        })
        .catch(() => {
          opening = false;
        });
    }, COPY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [awaitingCopy, getConvertedCopy, open, params.fileId]);

  const session = state.status === "ready" ? state.session : null;
  const editableId = session?.mode === "edit" ? (session.file.id ?? null) : null;

  // Editing from the first change, not from opening: a member who only reads is not shown.
  const [changed, setChanged] = useState<string | null>(null);
  const editedId = editableId && changed === editableId ? editableId : null;
  const left = useRef(false);
  useEffect(() => {
    if (!editedId) return;
    left.current = false;
    const beat = () => {
      if (!left.current) void officeHeartbeat(editedId, tab).catch(() => {});
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      if (!left.current) void endOfficeHeartbeat(editedId, tab);
    };
  }, [editedId, endOfficeHeartbeat, officeHeartbeat, tab]);

  // Covered until the engine wears Ruchoir's colours, per session; never while a conversion runs.
  const [paintedFor, setPaintedFor] = useState<string | null>(null);
  const token = session?.accessToken ?? null;
  useEffect(() => {
    if (!token) return;
    const timer = setTimeout(() => setPaintedFor(token), REVEAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [token]);
  const covered = !!token && paintedFor !== token && !awaitingCopy;

  // Closing says goodbye first and waits for it, so the file list does not show me still editing.
  const closing = useRef(false);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const done = () => {
      if (session) emit({ type: "files", spaceId: session.spaceId });
      navigation.goBack();
    };
    if (editedId && !left.current) {
      left.current = true;
      void endOfficeHeartbeat(editedId, tab).finally(done);
    } else done();
  }, [editedId, emit, endOfficeHeartbeat, navigation, session, tab]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const id = (JSON.parse(e.nativeEvent.data) as { MessageId?: string }).MessageId;
      if (id === "UI_Close") close();
      if (id === "Edit_Notification" && editableId) setChanged(editableId);
      if (id === "Ruchoir_Painted") setPaintedFor(token);
    } catch {
      // Not a WOPI message.
    }
  };

  const title = (state.status === "ready" ? (state.copy ?? state.session.file).name : params.name) ?? "";
  const reason = state.status === "error" ? state.reason : null;

  return (
    <FullScreen color={c.bg}>
      <View style={[styles.bar, { borderBottomColor: c.line }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={close} style={styles.icon}>
          <X size={24} color={c.ink} />
        </Pressable>
        <Text variant="heading" numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {editors.length > 0 ? (
          <View accessibilityLabel={t("office.editingNow", { names: editors.map((e) => e.name).join(", ") })}>
            <AvatarStack size={26} people={editors.slice(0, 4).map((e) => ({ name: e.name }))} />
          </View>
        ) : null}
      </View>
      {session ? (
        <View style={styles.fill}>
          <WebView
            key={session.accessToken}
            source={{
              uri: session.url,
              method: "POST",
              body: formBody(session),
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
            }}
            injectedJavaScriptBeforeContentLoaded={FORWARD}
            injectedJavaScriptBeforeContentLoadedForMainFrameOnly
            onMessage={onMessage}
            originWhitelist={["https://*"]}
            setSupportMultipleWindows={false}
            allowsBackForwardNavigationGestures={false}
            style={[styles.fill, covered && styles.hidden]}
          />
          {covered ? (
            <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.bg }]}>
              <ActivityIndicator color={c.ink} />
              <Text tone="muted">{t("office.opening")}</Text>
            </View>
          ) : null}
        </View>
      ) : state.status === "loading" ? (
        <View style={[styles.fill, styles.center]}>
          <ActivityIndicator color={c.ink} />
          <Text tone="muted">{t("office.opening")}</Text>
        </View>
      ) : (
        <View style={[styles.fill, styles.center]}>
          <Text variant="heading">{t("office.failed")}</Text>
          <Text tone="muted" style={styles.text}>
            {reason === "forbidden"
              ? t("office.forbidden")
              : reason === "unsupported"
                ? t("office.unsupported")
                : reason === "missing"
                  ? t("office.missing")
                  : reason === "conversion"
                    ? t("office.conversionFailed")
                    : reason === "unavailable"
                      ? t("office.unavailable")
                      : t("office.tryAgain")}
          </Text>
          <Button variant="secondary" label={t("common.close")} onPress={close} />
        </View>
      )}
    </FullScreen>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: hairline },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1 },
  fill: { flex: 1 },
  hidden: { opacity: 0 },
  center: { alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  text: { textAlign: "center" },
});
