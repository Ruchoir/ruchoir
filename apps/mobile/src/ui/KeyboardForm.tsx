/**
 * A form that scrolls, keeps the field being typed in above the keyboard, and keeps its `footer` (a
 * form's button) on the keyboard. Every form of the app is written with it rather than a bare
 * `ScrollView` inside a `KeyboardArea`.
 *
 * react-native-keyboard-controller's `KeyboardAwareScrollView` scrolls the form along with the
 * keyboard, frame by frame, from the moment a field takes the focus (and again when another one
 * does), and brings it back as the keyboard goes down. The field rides up with the keyboard; the
 * form's own scroll, which waited for the keyboard to rest and then scrolled, left the field behind
 * the keyboard for most of a second, and jumped back when the keyboard went down.
 *
 * The form runs to the bottom of its screen (a sheet's too), clear of the home indicator. The footer
 * rides on the keyboard (`KeyboardStickyView`), over the bottom of the form, which the keyboard
 * covers anyway; the focused field is kept above the footer (`bottomOffset`). The library places the
 * field from where the keyboard and the field really are on screen, a sheet's offset included.
 *
 * The room the form gains at its end while the keyboard is up is the keyboard's height plus the
 * footer's (`extraKeyboardSpace`): with the keyboard's alone, the last field (a group's topic) could
 * not scroll high enough and stayed under the footer.
 */
import { useState, type ReactNode } from "react";
import { StyleSheet, View, type ScrollViewProps } from "react-native";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Room kept between the focused field and what is under it (the footer, or the keyboard). */
const FIELD_MARGIN = 16;

export function KeyboardForm({
  children,
  footer,
  ...scroll
}: Omit<ScrollViewProps, "children"> & { children: ReactNode; footer?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [footerHeight, setFooterHeight] = useState(0);
  return (
    <View style={[styles.fill, { paddingBottom: insets.bottom }]}>
      <KeyboardAwareScrollView
        style={styles.fill}
        keyboardShouldPersistTaps="handled"
        {...scroll}
        bottomOffset={footerHeight + FIELD_MARGIN}
        extraKeyboardSpace={footer ? footerHeight + FIELD_MARGIN : 0}
      >
        {children}
      </KeyboardAwareScrollView>
      {footer ? (
        // Above the home indicator while the keyboard is down, right on the keyboard once it is up.
        <KeyboardStickyView offset={{ opened: insets.bottom }} onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}>
          {footer}
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
