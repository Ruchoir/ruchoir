import * as WebBrowser from "expo-web-browser";
import { StyleSheet, View } from "react-native";

import { parseInline } from "../../logic/inline";
import { fonts } from "../../theme/fonts";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import { CodeBlock } from "./CodeBlock";

/**
 * A message's body: lines, quotes, list items and code fences by line, and within a line the
 * segments of `parseInline` (mentions tinted with the accent, bold, italic, code, links).
 */
export function RichText({ body, mentionNames }: { body: string; mentionNames: string[] }) {
  const { c, s } = useTheme();
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
            {parseInline(block.text, mentionNames).map((seg, j) => {
              switch (seg.kind) {
                case "mention":
                  return (
                    <Text key={j} tone="onPastel" style={[styles.mention, { backgroundColor: c.acc }]}>
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

const styles = StyleSheet.create({
  body: { gap: 2 },
  line: { fontSize: 16, lineHeight: 23 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  mention: { fontFamily: fonts.sansSemibold, borderRadius: radius.s },
  italic: { fontStyle: "italic" },
  link: { textDecorationLine: "underline" },
});
