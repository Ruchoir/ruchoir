import { Search } from "lucide-react-native";
import { StyleSheet, TextInput, View } from "react-native";

import { fonts } from "../theme/fonts";
import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { useRevealField } from "./KeyboardScroll";

/** The search field at the top of a list (mockups 12 and 20). */
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (text: string) => void; placeholder: string }) {
  const { c } = useTheme();
  const reveal = useRevealField();
  return (
    <View style={[styles.box, { borderColor: c.controlLine, backgroundColor: c.surface }]}>
      <Search size={18} color={c.muted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        onFocus={reveal}
        style={[styles.input, { color: c.ink }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 46,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    borderRadius: radius.m,
    borderWidth: hairline,
  },
  input: { flex: 1, fontSize: 16, fontFamily: fonts.sans, height: "100%" },
});
