/**
 * The Android widgets (step 6e, mockup "Widgets Android"), drawn by react-native-android-widget from
 * a headless task, the app itself not running:
 *
 * - `RuchoirAgenda` (2×2): the next event, when it starts and where;
 * - `RuchoirDiscussions` (4×2): how much is unread, and the latest mentions;
 * - `RuchoirShortcuts` (4×1): new message, new event, agenda, files.
 *
 * They read the instance and the session token the app shares (`push/phone.ts`) and ask the instance
 * themselves, as the iPhone's widgets do (`targets/widgets`). A tap opens the app on a `ruchoir://`
 * link (`logic/deepLink.ts`). Light and dark, as the phone is.
 */
import * as SecureStore from "expo-secure-store";
import { FlexWidget, requestWidgetUpdate, TextWidget, type WidgetRepresentation, type WidgetTaskHandlerProps } from "react-native-android-widget";

import i18n, { key, type DictKey } from "../i18n";
import { SHARED, SHARED_SERVER, SHARED_TOKEN } from "../push/phone";
import { startsIn, unreadTotal, upcoming, type WireEvent } from "./data";

type HexColor = `#${string}`;
type Palette = { canvas: HexColor; ink: HexColor; muted: HexColor; brand: HexColor; card: HexColor };

const LIGHT: Palette = { canvas: "#f6f7f9", ink: "#15171c", muted: "#6b717d", brand: "#c65d45", card: "#ffffff" };
const DARK: Palette = { canvas: "#15171c", ink: "#f1f2f4", muted: "#9aa1ad", brand: "#d97a62", card: "#1e2128" };

type Note = { id: string; actor_name?: string; channel_name?: string; space_name: string; preview: string };

async function get<T>(path: string): Promise<T | null> {
  const [server, token] = await Promise.all([
    SecureStore.getItemAsync(SHARED_SERVER, SHARED),
    SecureStore.getItemAsync(SHARED_TOKEN, SHARED),
  ]);
  if (!server || !token) return null;
  try {
    const response = await fetch(`${server}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

async function signedIn(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(SHARED_TOKEN, SHARED));
}

const t = (name: DictKey, options?: Record<string, unknown>): string => (options ? i18n.t(name, options) : i18n.t(name)) as string;

function when(event: WireEvent, now: Date): string {
  if (event.all_day) return t("widgets.allDay");
  const start = new Date(event.start);
  const time = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(start);
  const soon = startsIn(start, now);
  switch (soon.kind) {
    case "now":
      return `${time} · ${t("widgets.now")}`;
    case "minutes":
      return `${time} · ${t("today.inMinutes", { count: soon.n })}`;
    case "hours":
      return `${time} · ${t("today.inHours", { count: soon.n })}`;
    case "later":
      return `${new Intl.DateTimeFormat(i18n.language, { weekday: "short", day: "numeric" }).format(start)} · ${time}`;
  }
}

function Frame({ palette, uri, children }: { palette: Palette; uri: string; children: React.ReactNode }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri }}
      style={{
        height: "match_parent",
        width: "match_parent",
        backgroundColor: palette.canvas,
        borderRadius: 20,
        padding: 14,
        flexDirection: "column",
      }}
    >
      {children}
    </FlexWidget>
  );
}

function Label({ text, palette }: { text: string; palette: Palette }) {
  return <TextWidget text={text} style={{ fontSize: 12, fontWeight: "600", color: palette.brand }} />;
}

function AgendaView({ palette, events, failed, out }: { palette: Palette; events: WireEvent[]; failed: boolean; out: boolean }) {
  const next = events[0];
  const now = new Date();
  return (
    <Frame palette={palette} uri="ruchoir://agenda">
      <Label text={t("widgets.next")} palette={palette} />
      <FlexWidget style={{ flex: 1, flexDirection: "column", justifyContent: "flex-end", width: "match_parent" }}>
        {next ? (
          <FlexWidget style={{ flexDirection: "column", width: "match_parent" }}>
            <TextWidget text={when(next, now)} style={{ fontSize: 13, color: palette.muted }} maxLines={1} />
            <TextWidget text={next.title} style={{ fontSize: 17, fontWeight: "700", color: palette.ink }} maxLines={2} truncate="END" />
            {next.location ? <TextWidget text={next.location} style={{ fontSize: 13, color: palette.muted }} maxLines={1} truncate="END" /> : null}
          </FlexWidget>
        ) : (
          <TextWidget
            text={out ? t("widgets.signIn") : failed ? t("widgets.unreachable") : t("agenda.nothingSoon")}
            style={{ fontSize: 14, color: palette.muted }}
            maxLines={3}
          />
        )}
      </FlexWidget>
    </Frame>
  );
}

function DiscussionsView({ palette, unread, notes, failed, out }: { palette: Palette; unread: number; notes: Note[]; failed: boolean; out: boolean }) {
  return (
    <Frame palette={palette} uri="ruchoir://discussions">
      <FlexWidget style={{ flexDirection: "row", width: "match_parent", alignItems: "center" }}>
        <FlexWidget style={{ flex: 1 }}>
          <Label text={t("tabs.discussions")} palette={palette} />
        </FlexWidget>
        {!out && !failed ? <TextWidget text={t("widgets.unread", { count: unread })} style={{ fontSize: 12, color: palette.muted }} /> : null}
      </FlexWidget>
      <FlexWidget style={{ flex: 1, flexDirection: "column", width: "match_parent", flexGap: 6, paddingTop: 8 }}>
        {out || failed || notes.length === 0 ? (
          <TextWidget
            text={out ? t("widgets.signIn") : failed ? t("widgets.unreachable") : t("widgets.allRead")}
            style={{ fontSize: 14, color: palette.muted }}
            maxLines={2}
          />
        ) : (
          notes.slice(0, 2).map((note) => (
            <FlexWidget key={note.id} style={{ flexDirection: "column", width: "match_parent", backgroundColor: palette.card, borderRadius: 12, padding: 8 }}>
              <TextWidget
                text={note.channel_name ? `#${note.channel_name}` : (note.actor_name ?? note.space_name)}
                style={{ fontSize: 13, fontWeight: "600", color: palette.ink }}
                maxLines={1}
                truncate="END"
              />
              <TextWidget text={note.preview} style={{ fontSize: 12, color: palette.muted }} maxLines={1} truncate="END" />
            </FlexWidget>
          ))
        )}
      </FlexWidget>
    </Frame>
  );
}

const SHORTCUTS = [
  { label: key("newMessage.title"), uri: "ruchoir://new-message" },
  { label: key("calendar.newEvent"), uri: "ruchoir://new-event" },
  { label: key("tabs.agenda"), uri: "ruchoir://agenda" },
  { label: key("tabs.files"), uri: "ruchoir://files" },
];

function ShortcutsView({ palette }: { palette: Palette }) {
  return (
    <FlexWidget
      style={{ height: "match_parent", width: "match_parent", backgroundColor: palette.canvas, borderRadius: 20, padding: 6, flexDirection: "row", flexGap: 6 }}
    >
      {SHORTCUTS.map((shortcut) => (
        <FlexWidget
          key={shortcut.uri}
          clickAction="OPEN_URI"
          clickActionData={{ uri: shortcut.uri }}
          style={{ flex: 1, height: "match_parent", backgroundColor: palette.card, borderRadius: 14, alignItems: "center", justifyContent: "center" }}
        >
          <TextWidget text={t(shortcut.label)} style={{ fontSize: 12, fontWeight: "600", color: palette.ink, textAlign: "center" }} maxLines={2} />
        </FlexWidget>
      ))}
    </FlexWidget>
  );
}

/** What a widget shows now, in the phone's light and dark; null for a widget this app does not know. */
async function render(widgetName: string): Promise<WidgetRepresentation | null> {
  const out = !(await signedIn());
  switch (widgetName) {
    case "RuchoirAgenda": {
      const now = new Date();
      const from = now.toISOString();
      const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();
      const events = out ? null : await get<WireEvent[]>(`/calendar/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const next = upcoming(events ?? [], now, 1);
      return {
        light: <AgendaView palette={LIGHT} events={next} failed={!out && events === null} out={out} />,
        dark: <AgendaView palette={DARK} events={next} failed={!out && events === null} out={out} />,
      };
    }
    case "RuchoirDiscussions": {
      const [spaces, page] = out
        ? [null, null]
        : await Promise.all([get<{ unread?: number }[]>("/me/spaces"), get<{ notifications: Note[] }>("/notifications?unread=true&limit=2")]);
      const unread = unreadTotal(spaces ?? []);
      const notes = page?.notifications ?? [];
      return {
        light: <DiscussionsView palette={LIGHT} unread={unread} notes={notes} failed={!out && spaces === null} out={out} />,
        dark: <DiscussionsView palette={DARK} unread={unread} notes={notes} failed={!out && spaces === null} out={out} />,
      };
    }
    case "RuchoirShortcuts":
      return { light: <ShortcutsView palette={LIGHT} />, dark: <ShortcutsView palette={DARK} /> };
    default:
      return null;
  }
}

/** The widgets' task: draw the one Android asks about (added, every half hour, resized). */
export async function widgetTaskHandler({ widgetInfo, widgetAction, renderWidget }: WidgetTaskHandlerProps): Promise<void> {
  if (widgetAction === "WIDGET_DELETED") return;
  const shown = await render(widgetInfo.widgetName);
  if (shown) renderWidget(shown);
}

const WIDGETS = ["RuchoirAgenda", "RuchoirDiscussions", "RuchoirShortcuts"];

/** Draw every widget placed on the home screen again (signed in, signed out). */
export async function refreshWidgets(): Promise<void> {
  for (const widgetName of WIDGETS) {
    await requestWidgetUpdate({
      widgetName,
      renderWidget: async () => (await render(widgetName)) ?? <ShortcutsView palette={LIGHT} />,
    }).catch(() => {});
  }
}
