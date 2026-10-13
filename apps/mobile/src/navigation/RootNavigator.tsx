import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { AttachSheet } from "../compose/AttachSheet";
import { AccountSheet } from "../screens/account/AccountSheet";
import { ConversationScreen } from "../screens/discussions/ConversationScreen";
import { EmojiPickerSheet } from "../screens/discussions/EmojiPickerSheet";
import { MessageActionSheet } from "../screens/discussions/MessageActionSheet";
import { SpaceFilePicker } from "../screens/discussions/SpaceFilePicker";
import { EventSummarySheet } from "../screens/agenda/EventSummarySheet";
import { FileViewerScreen } from "../screens/files/FileViewerScreen";
import { FolderScreen } from "../screens/files/FolderScreen";
import { SpaceSheet } from "../screens/space/SpaceSheet";
import { fonts } from "../theme/fonts";
import { useTheme } from "../theme/useTheme";
import { Tabs } from "./Tabs";
import type { RootParams } from "./types";

const Stack = createNativeStackNavigator<RootParams>();

/** The signed-in app: the tabs, the screens pushed over them, and the sheets. */
export function RootNavigator() {
  const { c, dark } = useTheme();
  const base = dark ? DarkTheme : DefaultTheme;
  const theme: Theme = {
    ...base,
    colors: { ...base.colors, primary: c.ink, background: c.bg, card: c.surface, text: c.ink, border: c.line, notification: c.alarm },
    fonts: {
      regular: { fontFamily: fonts.sans, fontWeight: "400" },
      medium: { fontFamily: fonts.sansMedium, fontWeight: "500" },
      bold: { fontFamily: fonts.sansSemibold, fontWeight: "600" },
      heavy: { fontFamily: fonts.sansBold, fontWeight: "700" },
    },
  };
  const sheet = { presentation: "formSheet", sheetAllowedDetents: "fitToContents", sheetGrabberVisible: true, headerShown: false } as const;

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="tabs" component={Tabs} />
        <Stack.Screen name="conversation" component={ConversationScreen} />
        <Stack.Screen name="folder" component={FolderScreen} />
        <Stack.Screen name="fileViewer" component={FileViewerScreen} options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="eventSummary" component={EventSummarySheet} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
        <Stack.Screen name="spaceSheet" component={SpaceSheet} options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
        <Stack.Screen name="accountSheet" component={AccountSheet} options={sheet} />
        <Stack.Screen name="messageActions" component={MessageActionSheet} options={sheet} />
        <Stack.Screen name="emojiPicker" component={EmojiPickerSheet} options={{ ...sheet, sheetAllowedDetents: [0.7, 1] }} />
        <Stack.Screen name="attachSheet" component={AttachSheet} options={sheet} />
        <Stack.Screen name="spaceFilePicker" component={SpaceFilePicker} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
