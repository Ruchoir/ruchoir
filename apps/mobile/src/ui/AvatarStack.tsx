import { StyleSheet, View } from "react-native";

import { useTheme } from "../theme/useTheme";
import { Avatar } from "./Avatar";

/**
 * The faces of a private conversation with several people: the first two, one over the other's
 * corner, in the room a single picture takes. A channel keeps its mark, a person their face.
 */
export function AvatarStack({ people, size = 44 }: { people: { name: string; avatarUrl?: string }[]; size?: number }) {
  const { c } = useTheme();
  const [first, second] = people;
  if (!first) return <Avatar name="" size={size} />;
  if (!second) return <Avatar name={first.name} src={first.avatarUrl} size={size} />;
  const face = Math.round(size * 0.68);
  return (
    <View style={{ width: size, height: size }} accessibilityIgnoresInvertColors>
      <View style={styles.back}>
        <Avatar name={first.name} src={first.avatarUrl} size={face} />
      </View>
      <View style={[styles.front, { borderColor: c.bg, borderRadius: face / 4 + 2 }]}>
        <Avatar name={second.name} src={second.avatarUrl} size={face} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { position: "absolute", top: 0, left: 0 },
  front: { position: "absolute", right: -2, bottom: -2, borderWidth: 2 },
});
