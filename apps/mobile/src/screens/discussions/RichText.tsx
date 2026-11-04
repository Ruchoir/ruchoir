import * as WebBrowser from "expo-web-browser";
import { StyleSheet, View } from "react-native";

import { parseInline } from "../../logic/inline";
import { fonts } from "../../theme/fonts";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import { CodeBlock } from "./CodeBlock";

/**
 * A message's body: lines, quotes, list items and code fences by line, and within a line the
 * segments of `parseInline` (mentions tinted with the accent, bold, italic, code, links).
 */
export function RichText({
  body,
  mentionNames,
  groupNames,
  onOpenGroup,
}: {
  body: string;
  mentionNames: string[];
  /** The names of the groups a `@` can reach, and what a tap on one does (open its people). */
  groupNames?: string[];
  onOpenGroup?: (mention: string) => void;
}) {
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const blocks: { kind: "line" | "quote" | "item" | "code"; text: string; lang?: string }[] = [];
  let fence: string[] | null = null;
  let lang: string | undefined;
  for (const line of body.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (fence) {
        blocks.push({ kind: "code", text: fence.join("\n"), lang });
        fence = null;
      } else {
        fence = [];
        // The language written after the opening fence, if any.
        lang = line.trim().slice(3).trim() || undefined;
      }
      continue;
    }
    if (fence) fence.push(line);
    else if (/^\s*>\s?/.test(line)) blocks.push({ kind: "quote", text: line.replace(/^\s*>\s?/, "") });
    else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) blocks.push({ kind: "item", text: line.replace(/^\s*[-*+]\s+/, "• ") });
    else blocks.push({ kind: "line", text: line });
  }
  if (fence) blocks.push({ kind: "code", text: fence.join("\n"), lang });

  return (
    <View style={styles.body}>
      {blocks.map((block, i) =>
        block.kind === "code" ? (
          <CodeBlock key={i} code={block.text} lang={block.lang} />
        ) : (
          <Text key={i} tone="strong" style={[styles.line, block.kind === "quote" && [styles.quote, { borderLeftColor: c.lineStrong, color: c.body }]]}>
            {parseInline(block.text, mentionNames, groupNames).map((seg, j) => {
              switch (seg.kind) {
                case "mention":
                  return (
                    <Text key={j} tone="onPastel" style={[styles.mention, { backgroundColor: c.acc }]}>
                      {seg.text}
                    </Text>
                  );
                case "group":
                  // A pill like a person's; a tap lists the group's people.
                  return (
                    <Text
                      key={j}
                      tone="onPastel"
                      accessibilityRole={onOpenGroup ? "button" : undefined}
                      onPress={onOpenGroup ? () => onOpenGroup(seg.text) : undefined}
                      style={[styles.mention, { backgroundColor: c.acc }]}
                    >
                      {seg.text}
                    </Text>
                  );
                case "bold":
                  return (
                    <Text key={j} variant="bodyStrong">
                      {seg.text}
                    </Text>
                  );
                case "italic":
                  return (
                    <Text key={j} style={styles.italic}>
                      {seg.text}
                    </Text>
                  );
                case "code":
                  return (
                    <Text key={j} variant="small" style={[{ fontFamily: fonts.mono, backgroundColor: s.sunken }]}>
                      {seg.text}
                    </Text>
                  );
                case "link":
                  return (
                    <Text key={j} tone="link" style={styles.link} onPress={() => void WebBrowser.openBrowserAsync(seg.text)}>
                      {seg.text}
                    </Text>
                  );
                default:
                  return seg.text;
              }
            })}
          </Text>
        ),
      )}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    body: { gap: 2 },
    line: { fontSize: 16, lineHeight: 23 },
    quote: { borderLeftWidth: 3, paddingLeft: 10 },
    mention: { fontFamily: fonts.sansSemibold, borderRadius: shape.radius.s },
    italic: { fontStyle: "italic" },
    link: { textDecorationLine: "underline" },
  }),
);
