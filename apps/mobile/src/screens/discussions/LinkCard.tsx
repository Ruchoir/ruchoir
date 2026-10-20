import type { LinkPreview } from "@ruchoir/client";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { Pressable, StyleSheet, View } from "react-native";

import { authHeadersFor, useApi } from "../../api/useApi";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

/**
 * A link's preview, as the server read it from the page (the phone never fetches it): the site's
 * colour on the edge, the domain, the title, two lines of description and the image when there is
 * one. A tap opens the page.
 */
export function LinkCard({ link }: { link: LinkPreview }) {
  const api = useApi();
  const { absoluteUrl } = api;
  const { c } = useTheme();
  const image = link.imageUrl ? absoluteUrl(link.imageUrl) : undefined;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={link.title ?? link.domain}
      onPress={() => void WebBrowser.openBrowserAsync(link.url)}
      style={({ pressed }) => [styles.card, { borderColor: c.line, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.edge, { backgroundColor: link.color ?? c.lineStrong }]} />
      <View style={styles.body}>
        <Text variant="tiny" tone="muted" numberOfLines={1}>
          {link.domain}
        </Text>
        {link.title ? (
          <Text variant="smallStrong" numberOfLines={2}>
            {link.title}
          </Text>
        ) : null}
        {link.description ? (
          <Text variant="small" tone="body" numberOfLines={2}>
            {link.description}
          </Text>
        ) : null}
        {image ? (
          <Image
            source={{ uri: image, headers: authHeadersFor(api, image) }}
            style={[
              styles.image,
              { aspectRatio: link.imageWidth && link.imageHeight ? Math.max(link.imageWidth / link.imageHeight, 1) : 1.91 },
            ]}
            contentFit="cover"
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", borderWidth: hairline, borderRadius: radius.m, overflow: "hidden", maxWidth: 340 },
  edge: { width: 4 },
  body: { flex: 1, minWidth: 0, gap: 3, padding: 10 },
  image: { width: "100%", borderRadius: radius.s, marginTop: 6 },
});
