/**
 * The bar to write in (mockup 13): `+`, the field, send. Above it when needed, from the bar up: the
 * files waiting to go, the edit banner, who is writing, and the `@` / `#` suggestions.
 *
 * A message goes through the outbox, which draws it at once and keeps it if it fails; the text of an
 * unsent message is the conversation's draft, kept while the app runs.
 */
import type { Channel, Member } from "@ruchoir/client";
import * as Haptics from "expo-haptics";
import { PenLine, Plus, Send } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTranslation } from "../i18n";
import { activeToken, broadcastsFor, fold, insertToken, matchPeople } from "../logic/mentions";
import { fonts } from "../theme/fonts";
import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Text } from "../ui/Text";
import { MentionSuggestions, type Suggestion } from "./MentionSuggestions";
import { PendingFiles } from "./PendingFiles";
import type { Attachments } from "./useAttachments";
import { useKeyboardShown } from "./useKeyboardShown";
import { useOutbox } from "./useOutbox";
import { useTypingSignal } from "./useTyping";

const MAX_SUGGESTIONS = 5;

export type Editing = { id: string; body: string };

type Props = {
  conversationId: string;
  /** Where the draft is kept: the conversation's id, or the thread's. */
  draftKey: string;
  /** The message a thread reply answers. */
  parentId?: string;
  placeholder: string;
  /** Who `@` suggests (the space's people), and the channels `#` does. */
  people: Member[];
  channels: Channel[];
  /** Whether `@canal` and `@ici` are offered: in a channel, not in a private conversation. */
  broadcasts: boolean;
  myUserId: string;
  /** My messages on screen with these words, which the outbox must not take for the new one. */
  baselineFor: (body: string) => string[];
  /** The line "Léa is writing…", already worded. */
  typing?: string;
  /** A message being edited: the field holds its text, and sending saves it. */
  editing?: Editing | null;
  onSaveEdit?: (id: string, body: string) => void;
  onCancelEdit?: () => void;
  /** After a message is handed to the outbox (the list scrolls down to it). */
  onSent?: () => void;
  /** `+`: what can be added to the message. Without it, the button is not drawn. */
  onAttach?: () => void;
  /** The files waiting to go with the message (kept by the screen, so an edit does not lose them). */
  attachments?: Attachments;
};

export function Composer(props: Props) {
  const { conversationId, draftKey, parentId, people, channels, broadcasts, myUserId, editing } = props;
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  const outbox = useOutbox();
  const signalTyping = useTypingSignal(conversationId);
  // The parent remounts the composer when the draft or the edited message changes (its `key`).
  const [text, setText] = useState(() => (editing ? editing.body : outbox.draft(draftKey)));
  const [cursor, setCursor] = useState(text.length);
  const [forced, setForced] = useState<{ start: number; end: number } | undefined>(undefined);

  const token = useMemo(() => activeToken(text, cursor), [text, cursor]);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    if (token.kind === "#") {
      const q = fold(token.query);
      return channels
        .filter((ch) => ch.type !== "archived" && fold(ch.name).includes(q))
        .slice(0, MAX_SUGGESTIONS)
        .map((ch) => ({ kind: "channel", key: `#${ch.id}`, name: ch.name, detail: ch.topic }));
    }
    const rooms: Suggestion[] = broadcasts
      ? broadcastsFor(token.query).map((name) => ({
          kind: "broadcast",
          key: `@${name}`,
          name,
          detail: name === "canal" ? t("compose.broadcastChannel") : t("compose.broadcastHere"),
        }))
      : [];
    const found = matchPeople(
      people.filter((p) => p.userId !== myUserId),
      token.query,
      MAX_SUGGESTIONS - rooms.length,
    ).map(
      (p): Suggestion => ({ kind: "person", key: p.userId, name: p.name, detail: p.title, avatar: p.avatarUrl, bot: p.bot }),
    );
    return [...rooms, ...found];
  }, [token, channels, people, broadcasts, myUserId, t]);

  const change = (next: string) => {
    setText(next);
    if (!editing) {
      outbox.keepDraft(draftKey, next);
      if (next.trim()) signalTyping();
    }
  };

  const pick = (item: Suggestion) => {
    if (!token) return;
    const next = insertToken(text, token, item.name);
    change(next.text);
    setCursor(next.cursor);
    setForced({ start: next.cursor, end: next.cursor });
  };

  const files = editing ? undefined : props.attachments;
  const body = text.trim();
  // Files go with the text once they have all arrived; one that failed has to be retried or removed.
  const waiting = !!files && (files.uploading || files.failed);
  const ready = (body.length > 0 || (files?.attachments.length ?? 0) > 0) && !waiting;

  const submit = () => {
    if (!ready) return;
    if (editing) {
      props.onSaveEdit?.(editing.id, body);
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    outbox.send({
      conversationId,
      body,
      attachments: files?.attachments ?? [],
      images: files?.images,
      parentId,
      baseline: props.baselineFor(body),
    });
    files?.clear();
    change("");
    setCursor(0);
    props.onSent?.();
  };

  return (
    <View style={[styles.box, { backgroundColor: c.surface, borderTopColor: c.line }]}>
      <MentionSuggestions items={suggestions} onPick={pick} />
      {props.typing ? (
        <Text variant="tiny" tone="muted" numberOfLines={1} style={styles.typing}>
          {props.typing}
        </Text>
      ) : null}
      {editing ? (
        <View style={[styles.banner, { backgroundColor: s.selected }]}>
          <PenLine size={16} color={c.ink} />
          <Text variant="smallStrong" style={styles.grow}>
            {t("compose.editing")}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={props.onCancelEdit}>
            <Text variant="smallStrong" tone="link">
              {t("compose.cancel")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {files ? <PendingFiles attachments={files} /> : null}
      <View style={[styles.bar, { paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 8) }]}>
        {props.onAttach && !editing ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("compose.add")}
            onPress={props.onAttach}
            style={({ pressed }) => [styles.square, { borderColor: c.controlLine, borderWidth: hairline }, pressed && { backgroundColor: s.pressed }]}
          >
            <Plus size={22} color={c.ink} />
          </Pressable>
        ) : null}
        <TextInput
          value={text}
          onChangeText={change}
          onSelectionChange={(e) => {
            setCursor(e.nativeEvent.selection.end);
            if (forced) setForced(undefined);
          }}
          selection={forced}
          placeholder={props.placeholder}
          placeholderTextColor={c.muted}
          multiline
          autoFocus={!!editing}
          accessibilityLabel={props.placeholder}
          style={[styles.field, { borderColor: c.controlLine, color: c.ink }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? t("compose.save") : t("compose.send")}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={submit}
          style={({ pressed }) => [
            styles.square,
            { borderColor: c.ink, borderWidth: 2 },
            ready && { backgroundColor: c.ink },
            pressed && { opacity: 0.8 },
          ]}
        >
          {files?.uploading ? <ActivityIndicator color={c.ink} /> : <Send size={20} color={ready ? c.onInk : c.ink} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderTopWidth: hairline },
  typing: { paddingHorizontal: 16, paddingTop: 6 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  grow: { flex: 1 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  square: { width: 44, height: 44, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  field: {
    flex: 1,
    minHeight: 44,
    // Five lines of text, then it scrolls.
    maxHeight: 5 * 21 + 22,
    borderWidth: hairline,
    borderRadius: radius.m,
    paddingHorizontal: 12,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 16,
    lineHeight: 21,
    fontFamily: fonts.sans,
  },
});
