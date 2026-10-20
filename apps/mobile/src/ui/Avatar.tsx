/**
 * A person's or a space's picture: the uploaded one when there is one, else the same DiceBear face
 * the web draws for that name (generated on the phone, never fetched), with an optional presence dot.
 */
import { Avatar as DiceAvatar, Style } from "@dicebear/core";
import blobsDef from "@dicebear/styles/blobs.json";
import cameoDef from "@dicebear/styles/cameo.json";
import gazeDef from "@dicebear/styles/gaze.json";
import type { Presence } from "@ruchoir/client";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { authHeadersFor, useApi } from "../api/useApi";
import { radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";

export type AvatarKind = "person" | "bot" | "workspace";

/** The web's palettes per subject (`apps/web/lib/avatar.ts`), so a name has one face everywhere. */
const BACKGROUND: Record<AvatarKind, string[]> = {
  person: ["7cc0f0", "6fe0c2", "ffd84d", "b592f0", "56d8d4", "8fd98f"],
  bot: ["56d8d4", "7cc0f0", "b592f0"],
  workspace: ["ffb3ba", "ffdfba", "ffe680", "8fe6a3", "8fd0ff", "c9a8ff", "f5b0f0"],
};

const STYLES: Record<AvatarKind, Style<object>> = {
  person: new Style(cameoDef as never),
  bot: new Style(gazeDef as never),
  workspace: new Style(blobsDef as never),
};

const cache = new Map<string, string>();

function generated(seed: string, kind: AvatarKind): string {
  const key = `${kind}:${seed || "ruchoir"}`;
  let svg = cache.get(key);
  if (!svg) {
    svg = new DiceAvatar(STYLES[kind], { seed: seed || "ruchoir", backgroundColor: BACKGROUND[kind] }).toString();
    cache.set(key, svg);
  }
  return svg;
}

/** `--presence-*` of the web. */
const PRESENCE: Record<Presence, string> = {
  online: "#1a9e78",
  away: "#f0b400",
  busy: "#f4522a",
  offline: "#cfd3da",
};

export function Avatar({
  name,
  src,
  size = 40,
  kind = "person",
  presence,
}: {
  name: string;
  src?: string;
  size?: number;
  kind?: AvatarKind;
  presence?: Presence;
}) {
  const api = useApi();
  const { absoluteUrl } = api;
  const { c } = useTheme();
  const [failed, setFailed] = useState(false);
  const svg = useMemo(() => generated(name, kind), [name, kind]);
  const corner = size >= 32 ? radius.m : radius.s;
  const dot = size >= 36 ? 10 : size >= 24 ? 8 : 6;
  const showPhoto = src && !failed;

  return (
    <View style={{ width: size, height: size }} accessibilityIgnoresInvertColors>
      <View style={[styles.frame, { width: size, height: size, borderRadius: corner, backgroundColor: c.line }]}>
        {showPhoto ? (
          <Image
            source={{ uri: absoluteUrl(src), headers: authHeadersFor(api, absoluteUrl(src)) }}
            style={{ width: size, height: size }}
            contentFit="cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <SvgXml xml={svg} width={size} height={size} />
        )}
      </View>
      {presence ? (
        <View
          style={[
            styles.dot,
            { width: dot, height: dot, borderRadius: dot, backgroundColor: PRESENCE[presence], borderColor: c.surface },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden" },
  dot: { position: "absolute", right: -2, bottom: -2, borderWidth: 1.5 },
});
