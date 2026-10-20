/**
 * The Android widgets (widget mockup "Widgets Android"), drawn by react-native-android-widget from a
 * headless task, the app itself not running, Material 3 shapes, in the theme chosen in the app:
 *
 * - `RuchoirShortcuts` (4×1): new message, new event, add a file, search;
 * - `RuchoirAgenda` (2×2, "Next"): the next event, when it starts and where;
 * - `RuchoirReply` (2×2, "To answer"): who addressed the reader; an invitation is answered "Yes" there;
 * - `RuchoirDiscussions` (4×2): the space's latest conversations, and "New message".
 *
 * They read the instances and session tokens the app shares (`push/phone.ts`), the space on screen,
 * its instance and the theme (`widgets/share.ts`), and ask the instances themselves, as the iPhone's
 * widgets do (`targets/widgets`): "Next" and "To answer" over every instance (ADR 0007), the
 * conversations of the space on screen. A tap opens the app on a `ruchoir://` link
 * (`logic/deepLink.ts`).
 */
import * as SecureStore from "expo-secure-store";
import {
  FlexWidget,
  ImageWidget,
  requestWidgetUpdate,
  SvgWidget,
  TextWidget,
  type WidgetRepresentation,
  type WidgetTaskHandlerProps,
} from "react-native-android-widget";

import i18n, { key, type DictKey } from "../i18n";
import { SHARED, SHARED_ACCOUNTS } from "../push/phone";
import { fromEvery, parseSharedAccounts, type SharedAccount } from "../push/shared";
import { initials, mixHex, previewOf, startsIn, upcoming, widgetPalette, type WidgetPalette, type WireEvent, type WireLast } from "./data";
import { glyph, type Glyph } from "./icons";
import { SHARED_SPACE, SHARED_SPACE_SERVER, SHARED_THEME } from "./keys";

const mark = require("../../assets/mark.png");

type Note = {
  id: string;
  kind: string;
  actor_name?: string;
  channel_name?: string;
  space_name: string;
  conversation_id?: string;
  event_id?: string;
  event_title?: string;
  preview: string;
  created_at?: string;
  /** The instance it came from, added here: where "Yes" is answered. */
  server?: string;
};
type Event = WireEvent & { event_id: string; server?: string };

/** `&server=...`, so a tap opens what came from another instance there (`logic/deepLink.ts`). */
const serverParam = (server?: string) => (server ? `&server=${encodeURIComponent(server)}` : "");
type Row = { id: string; name: string; channel: boolean; unread: number; at?: string; preview: string; space: string };

async function accounts(): Promise<SharedAccount[]> {
  return parseSharedAccounts(await SecureStore.getItemAsync(SHARED_ACCOUNTS, SHARED).catch(() => null));
}

async function get<T>(account: SharedAccount | undefined, path: string, init?: { method: string; body: string }): Promise<T | null> {
  if (!account) return null;
  const { server, token } = account;
  try {
    const response = await fetch(`${server}/api/v1${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init ? { "content-type": "application/json" } : {}) },
    });
    return response.ok ? ((await response.json().catch(() => ({}))) as T) : null;
  } catch {
    return null;
  }
}


const t = (name: DictKey, options?: Record<string, unknown>): string => (options ? i18n.t(name, options) : i18n.t(name)) as string;

const time = (date: Date) => new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(date);

/** "in 2 h", "in 20 min", "now", or the day for later. */
function soon(event: WireEvent, now: Date): string {
  const start = new Date(event.start);
  const when = startsIn(start, now);
  switch (when.kind) {
    case "now":
      return t("widgets.now");
    case "minutes":
      return t("today.inMinutes", { count: when.n });
    case "hours":
      return t("today.inHours", { count: when.n });
    case "later":
      return new Intl.DateTimeFormat(i18n.language, { weekday: "short", day: "numeric" }).format(start);
  }
}

function Icon({ name, color, size }: { name: Glyph; color: string; size: number }) {
  return <SvgWidget svg={glyph(name, color)} style={{ height: size, width: size }} />;
}

/** A widget's card: Material 3's large radius, the app's surface. */
function Card({ p, uri, background, children, padding = 16 }: { p: WidgetPalette; uri?: string; background?: `#${string}`; children: React.ReactNode; padding?: number }) {
  return (
    <FlexWidget
      {...(uri ? { clickAction: "OPEN_URI", clickActionData: { uri } } : {})}
      style={{ height: "match_parent", width: "match_parent", backgroundColor: background ?? p.surface, borderRadius: 28, padding, flexDirection: "column" }}
    >
      {children}
    </FlexWidget>
  );
}

function Message({ p, text }: { p: WidgetPalette; text: string }) {
  return <TextWidget text={text} style={{ fontSize: 13, color: p.muted }} maxLines={3} />;
}

const SHORTCUTS: { label: DictKey; uri: string; icon: Glyph; tint: keyof WidgetPalette }[] = [
  { label: key("newMessage.title"), uri: "ruchoir://new-message", icon: "square-pen", tint: "sky" },
  { label: key("calendar.newEvent"), uri: "ruchoir://new-event", icon: "calendar-plus", tint: "violet" },
  { label: key("eventForm.addFile"), uri: "ruchoir://add-file", icon: "upload", tint: "mint" },
  { label: key("widgets.search"), uri: "ruchoir://search", icon: "search", tint: "sun" },
];

/** The four gestures, each a pastel tile and its name. */
function ShortcutsView({ p }: { p: WidgetPalette }) {
  return (
    <FlexWidget
      style={{ height: "match_parent", width: "match_parent", backgroundColor: p.surface, borderRadius: 28, padding: 12, flexDirection: "row", flexGap: 6 }}
    >
      {SHORTCUTS.map((s) => (
        <FlexWidget
          key={s.uri}
          clickAction="OPEN_URI"
          clickActionData={{ uri: s.uri }}
          style={{ flex: 1, height: "match_parent", flexDirection: "column", alignItems: "center", justifyContent: "center", flexGap: 6 }}
        >
          <FlexWidget style={{ height: 52, width: 52, borderRadius: 18, backgroundColor: p[s.tint] as `#${string}`, alignItems: "center", justifyContent: "center" }}>
            <Icon name={s.icon} color={p.onPastel} size={22} />
          </FlexWidget>
          <TextWidget text={t(s.label)} style={{ fontSize: 11, fontWeight: "600", color: p.strong, textAlign: "center" }} maxLines={2} />
        </FlexWidget>
      ))}
    </FlexWidget>
  );
}

/** "Next": the next event on a tint of the accent. */
function NextView({ p, event, message }: { p: WidgetPalette; event?: Event; message?: string }) {
  const now = new Date();
  const uri = event ? `ruchoir://event/${event.event_id}?start=${encodeURIComponent(event.start)}${serverParam(event.server)}` : "ruchoir://agenda";
  return (
    <Card p={p} uri={uri} background={mixHex(p.acc, p.surface, 0.34)}>
      <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: 6 }}>
        <Icon name="calendar" color={p.strong} size={15} />
        <TextWidget text={t("widgets.next")} style={{ fontSize: 12, fontWeight: "700", color: p.strong }} />
      </FlexWidget>
      <FlexWidget style={{ flex: 1, width: "match_parent", flexDirection: "column", justifyContent: "flex-end", flexGap: 2 }}>
        {event ? (
          <>
            <TextWidget
              text={event.all_day ? t("widgets.allDay") : time(new Date(event.start))}
              style={{ fontSize: 28, fontWeight: "700", fontFamily: "monospace", color: p.strong }}
              maxLines={1}
            />
            <TextWidget text={event.title} style={{ fontSize: 15, fontWeight: "700", color: p.strong }} maxLines={2} truncate="END" />
            <TextWidget
              text={[event.location, soon(event, now)].filter(Boolean).join(" · ")}
              style={{ fontSize: 12, color: p.body }}
              maxLines={1}
              truncate="END"
            />
          </>
        ) : (
          <Message p={p} text={message ?? t("agenda.nothingSoon")} />
        )}
      </FlexWidget>
    </Card>
  );
}

/** What a notification says, in the words of Today's card ("Léa vous a mentionné"). */
function title(note: Note): string {
  const who = note.actor_name?.split(" ")[0] ?? t("message.someone");
  switch (note.kind) {
    case "calendar_invitation":
      return t("widgets.invited", { who, title: note.event_title ?? "" });
    case "reply":
      return t("today.replied", { who });
    case "dm":
      return t("today.wrote", { who });
    case "broadcast":
      return t("today.broadcast", { who });
    default:
      return t("today.mentioned", { who });
  }
}

/** "To answer": who addressed the reader; "Yes" for an invitation, "Open" for the rest. */
function ReplyView({ p, note, message }: { p: WidgetPalette; note?: Note; message?: string }) {
  const open = note?.conversation_id
    ? `ruchoir://conversation/${note.conversation_id}?title=${encodeURIComponent(note.channel_name ?? note.actor_name ?? "Ruchoir")}&channel=${note.channel_name ? "1" : "0"}${serverParam(note.server)}`
    : note?.event_id
      ? `ruchoir://event/${note.event_id}?${serverParam(note.server).slice(1)}`
      : "ruchoir://discussions";
  return (
    <Card p={p}>
      <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: 6 }}>
        <ImageWidget image={mark} imageWidth={16} imageHeight={16} />
        <TextWidget text={t("widgets.toAnswer")} style={{ fontSize: 12, fontWeight: "700", color: p.strong }} />
      </FlexWidget>
      <FlexWidget style={{ flex: 1, width: "match_parent", flexDirection: "column", justifyContent: "flex-end", flexGap: 8 }}>
        {note ? (
          <>
            <TextWidget text={title(note)} style={{ fontSize: 15, fontWeight: "700", color: p.strong }} maxLines={3} truncate="END" />
            <FlexWidget style={{ flexDirection: "row", width: "match_parent", flexGap: 6 }}>
              {note.kind === "calendar_invitation" && note.event_id ? (
                <FlexWidget
                  clickAction="ACCEPT"
                  clickActionData={{ eventId: note.event_id, notificationId: note.id, server: note.server ?? "" }}
                  style={{ flex: 1, height: 36, borderRadius: 18, backgroundColor: p.acc, alignItems: "center", justifyContent: "center" }}
                >
                  <TextWidget text={t("calendar.answer.accepted")} style={{ fontSize: 12.5, fontWeight: "700", color: p.onPastel }} />
                </FlexWidget>
              ) : null}
              <FlexWidget
                clickAction="OPEN_URI"
                clickActionData={{ uri: open }}
                style={{ flex: 1, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: p.line, alignItems: "center", justifyContent: "center" }}
              >
                <TextWidget text={t("today.open")} style={{ fontSize: 12.5, fontWeight: "600", color: p.strong }} />
              </FlexWidget>
            </FlexWidget>
          </>
        ) : (
          <Message p={p} text={message ?? t("widgets.allRead")} />
        )}
      </FlexWidget>
    </Card>
  );
}

/** The space's latest conversations, round faces, their unread counts, and "New message". */
function DiscussionsView({ p, rows, message }: { p: WidgetPalette; rows: Row[]; message?: string }) {
  return (
    <Card p={p} uri="ruchoir://discussions" padding={14}>
      <FlexWidget style={{ flexDirection: "row", width: "match_parent", alignItems: "center", paddingBottom: 4 }}>
        <FlexWidget style={{ flex: 1 }}>
          <TextWidget text={t("tabs.discussions")} style={{ fontSize: 14, fontWeight: "700", color: p.strong }} />
        </FlexWidget>
        <FlexWidget
          clickAction="OPEN_URI"
          clickActionData={{ uri: "ruchoir://new-message" }}
          style={{ height: 36, width: 36, borderRadius: 12, backgroundColor: p.onPastel, borderWidth: 1.5, borderColor: p.acc, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="square-pen" color={p.acc} size={16} />
        </FlexWidget>
      </FlexWidget>
      {message || rows.length === 0 ? (
        <Message p={p} text={message ?? t("widgets.noConversation")} />
      ) : (
        rows.map((row) => (
          <FlexWidget
            key={row.id}
            clickAction="OPEN_URI"
            clickActionData={{
              uri: `ruchoir://conversation/${row.id}?title=${encodeURIComponent(row.name)}&space=${row.space}&channel=${row.channel ? "1" : "0"}`,
            }}
            style={{ flexDirection: "row", width: "match_parent", alignItems: "center", flexGap: 10, height: 44 }}
          >
            <FlexWidget style={{ height: 34, width: 34, borderRadius: 17, backgroundColor: p[(["sky", "mint", "violet", "pink", "peach", "sun"] as const)[row.name.length % 6]], alignItems: "center", justifyContent: "center" }}>
              <TextWidget text={initials(row.name)} style={{ fontSize: 13, fontWeight: "700", color: p.onPastel }} />
            </FlexWidget>
            <FlexWidget style={{ flex: 1, flexDirection: "column" }}>
              <TextWidget text={row.name} style={{ fontSize: 13.5, fontWeight: "700", color: p.strong }} maxLines={1} truncate="END" />
              <TextWidget text={row.preview} style={{ fontSize: 12, color: p.body }} maxLines={1} truncate="END" />
            </FlexWidget>
            {row.unread > 0 ? (
              <FlexWidget
                style={{
                  height: 18,
                  paddingHorizontal: 5,
                  borderRadius: 9,
                  backgroundColor: row.channel ? p.acc : p.strong,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <TextWidget
                  text={row.unread > 99 ? "99+" : String(row.unread)}
                  style={{ fontSize: 11, fontWeight: "700", fontFamily: "monospace", color: row.channel ? p.onPastel : p.surface }}
                />
              </FlexWidget>
            ) : null}
          </FlexWidget>
        ))
      )}
    </Card>
  );
}

/** The palette of the app's theme, for the phone's day and its night. */
async function palettes(): Promise<{ light: WidgetPalette; dark: WidgetPalette }> {
  const theme = await SecureStore.getItemAsync(SHARED_THEME, SHARED).catch(() => null);
  return { light: widgetPalette(theme, false), dark: widgetPalette(theme, true) };
}

/** The space's conversations, most recent first. */
async function conversations(account: SharedAccount, space: string): Promise<Row[] | null> {
  type Channel = { id: string; name: string; member: boolean; unread: number; last_message?: WireLast };
  type Direct = { id: string; name: string; unread: number; last_message?: WireLast };
  const [channels, directs] = await Promise.all([get<Channel[]>(account, `/spaces/${space}/channels`), get<Direct[]>(account, `/spaces/${space}/dms`)]);
  if (!channels && !directs) return null;
  const said = (who: string, text: string) => t("discussions.by", { who, text });
  const you = t("spaceAdmin.you");
  return [
    ...(channels ?? []).filter((c) => c.member).map((c) => ({ ...c, channel: true })),
    ...(directs ?? []).map((d) => ({ ...d, channel: false })),
  ]
    .map((c) => ({ id: c.id, name: c.name, channel: c.channel, unread: c.unread, at: c.last_message?.created_at, preview: previewOf(c.last_message, you, said), space }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/** What a widget shows now, in the app's theme; null for a widget this app does not know. */
async function render(widgetName: string): Promise<WidgetRepresentation | null> {
  const all = await accounts();
  const out = all.length === 0;
  // Asked of every instance: null when none of them answered.
  const fromAll = async <T,>(path: string): Promise<T[] | null> => {
    const answers = (await fromEvery(all, (account) => get<T[]>(account, path).then((rows) => rows && rows.map((row) => ({ ...row, server: account.server }))))).flatMap(
      (a) => (a.value ? [a.value] : []),
    );
    return answers.length === 0 ? null : answers.flat();
  };
  const { light, dark } = await palettes();
  const both = (draw: (p: WidgetPalette) => React.JSX.Element) => ({ light: draw(light), dark: draw(dark) });
  switch (widgetName) {
    case "RuchoirShortcuts":
      return both((p) => <ShortcutsView p={p} />);
    case "RuchoirAgenda": {
      if (out) return both((p) => <NextView p={p} message={t("widgets.signIn")} />);
      const now = new Date();
      const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();
      const events = await fromAll<Event>(`/calendar/occurrences?from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(to)}`);
      const next = upcoming(events ?? [], now, 1)[0] as Event | undefined;
      return both((p) => <NextView p={p} event={next} message={events === null ? t("widgets.unreachable") : undefined} />);
    }
    case "RuchoirReply": {
      if (out) return both((p) => <ReplyView p={p} message={t("widgets.signIn")} />);
      const pages = await fromEvery(all, (account) =>
        get<{ notifications: Note[] }>(account, "/notifications?unread=true&limit=20").then((page) =>
          page ? page.notifications.map((n) => ({ ...n, server: account.server })) : null,
        ),
      );
      const answered = pages.flatMap((a) => (a.value ? [a.value] : []));
      const asking = new Set(["mention", "reply", "dm", "broadcast", "calendar_invitation"]);
      const note = answered
        .flat()
        .filter((n) => asking.has(n.kind))
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
      return both((p) => <ReplyView p={p} note={note} message={answered.length === 0 ? t("widgets.unreachable") : undefined} />);
    }
    case "RuchoirDiscussions": {
      if (out) return both((p) => <DiscussionsView p={p} rows={[]} message={t("widgets.signIn")} />);
      // The space on screen, on its own instance.
      const [server, chosen] = await Promise.all([
        SecureStore.getItemAsync(SHARED_SPACE_SERVER, SHARED).catch(() => null),
        SecureStore.getItemAsync(SHARED_SPACE, SHARED).catch(() => null),
      ]);
      const account = all.find((a) => a.server === server) ?? all[0];
      const spaces = await get<{ id: string }[]>(account, "/me/spaces");
      const space = spaces?.find((s) => s.id === chosen)?.id ?? spaces?.[0]?.id;
      const rows = space ? await conversations(account, space) : null;
      return both((p) => <DiscussionsView p={p} rows={(rows ?? []).slice(0, 3)} message={spaces === null || (space && rows === null) ? t("widgets.unreachable") : undefined} />);
    }
    default:
      return null;
  }
}

/** The widgets' task: draw the one Android asks about (added, every half hour, resized, tapped). */
export async function widgetTaskHandler({ widgetInfo, widgetAction, clickAction, clickActionData, renderWidget }: WidgetTaskHandlerProps): Promise<void> {
  if (widgetAction === "WIDGET_DELETED") return;
  // "Yes" to an invitation, from "To answer": the answer goes, the notification is read, and the
  // widget draws what comes next.
  if (widgetAction === "WIDGET_CLICK" && clickAction === "ACCEPT" && typeof clickActionData?.eventId === "string") {
    const all = await accounts();
    const account = all.find((a) => a.server === clickActionData.server) ?? all[0];
    await get(account, `/events/${clickActionData.eventId}/response`, { method: "PUT", body: JSON.stringify({ status: "accepted" }) });
    if (typeof clickActionData.notificationId === "string") {
      await get(account, `/notifications/${clickActionData.notificationId}/read`, { method: "PUT", body: "{}" });
    }
  }
  const shown = await render(widgetInfo.widgetName);
  if (shown) renderWidget(shown);
}

const WIDGETS = ["RuchoirShortcuts", "RuchoirAgenda", "RuchoirReply", "RuchoirDiscussions"];

/** Draw every widget placed on the home screen again (signed in, signed out, theme changed). */
export async function refreshWidgets(): Promise<void> {
  for (const widgetName of WIDGETS) {
    await requestWidgetUpdate({
      widgetName,
      renderWidget: async () => (await render(widgetName)) ?? (await palettes().then(({ light }) => <ShortcutsView p={light} />)),
    }).catch(() => {});
  }
}
