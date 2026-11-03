import { Search } from "lucide-react-native";
import { StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from "react-native";

import { fonts } from "../theme/fonts";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";

/** The search field at the top of a list (mockups 12 and 20). */
export function SearchField({
  value,
  onChange,
  placeholder,
  style,
  autoFocus,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  /** In a sheet, whose own padding already makes the gutter: `{ marginHorizontal: 0 }`. */
  style?: StyleProp<ViewStyle>;
  autoFocus?: boolean;
}) {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.box, { borderColor: c.controlLine, backgroundColor: c.surface }, style]}>
      <Search size={18} color={c.muted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        autoFocus={autoFocus}
        style={[styles.input, { color: c.ink }]}
      />
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    box: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      height: 46,
      marginHorizontal: 16,
      paddingHorizontal: 12,
      borderRadius: shape.radius.m,
      borderWidth: shape.hairline,
    },
    input: { flex: 1, fontSize: 16, fontFamily: fonts.sans, height: "100%" },
  }),
);
